# Design plan notes

## Co-Pilot landing shortcuts (empty state)

Replaces the co-pilot's bare example-text empty state with four shortcut cards, so
a first-time user sees what the co-pilot can do, with the part-number builder
promoted to the front door rather than hidden behind exact phrasing.

### The four cards (in order)

1. **Build a part number** (live, leads). Sub: "Turn process conditions into a
   valid part number, step by step." Sends `build a part number`, which the real
   `converse.mjs` router answers with the model-choice prompt ("which one?"), so
   the card drops straight into the guided flow.
2. **Product and spec questions** (live). Sub: "Ask about a product line, a
   datasheet, a rating or a material." Pre-fills the input with an editable
   example ("what is the pressure rating of the Marwin CV3000?") and focuses it.
   Does not send.
3. **How PCT sells** (live). Sub: "Process, qualification and policy, from PCT's
   own playbook." Pre-fills an editable example ("how do we qualify an
   opportunity?"). Surfaces that the co-pilot knows the methodology corpus, not
   only datasheets.
4. **Look up a price** (disabled, honest). Sub: "Sales pricing from PCT price
   lists. Available once the lists are loaded." Rendered visibly, not in the tab
   order, with a "Coming" marker. Changes nothing in the send or pricing paths.

### Card anatomy, against the repo's real tokens

The brief named `--pct-navy / --pct-ink-2 / --pct-line`; the repo's actual tokens
are `--navy (#1F386B)`, `--ink2 (#5B6B8C)`, `--line (#E3E7EE)`, `--paper
(#F7F8FA)`, on Mulish. I built against the real names.

- White card, 1px `--line` border, 10px radius, matching the existing `.card`.
- Glyphs from the existing nav set (`icons.jsx`): build = pipeline (a sequence of
  steps), product = copilot, sells = accounts (a playbook document), price =
  insights, muted.
- Heading Mulish 600 `--navy` (live) or `--ink2` (disabled); one-line `--ink2`
  sublabel.
- Live cards reveal a small `ChevronRight` and a one-pixel hover lift, no heavier
  than the existing cards; focusable with the app's `2px solid --blue` ring. The
  disabled card shows the "Coming" eyebrow, no hover, `aria-disabled`, out of the
  tab order.
- The flow line is not used on the cards: it keeps its three sanctioned homes
  (header brand line, pipeline track, loading shimmer). The cards earn their
  identity from the card grammar.

### Returning to the shortcuts

A "Back to shortcuts" control sits at the top of an active conversation (sticky,
with a `ChevronLeft`), so the landing is one tap away. It clears the conversation
and any build in progress, which re-renders the empty-state cards. The freeform
input and "Or just type" line behave exactly as before.

### Self-critique: native to the PCT instrument panel, or borrowed?

Native. It is built from the repo's own `.card` grammar, nav icon set, eyebrow
labels, Mulish and `--ink2` sublabels, and the existing `--blue` focus ring and
hover weight. Two deliberate choices keep it from reading as borrowed from the
sister product: the hero is the part-number builder, not a contact list (the
co-pilot is knowledge and product centric, people live in Pipeline and Accounts),
and the unconnected pricing tile uses our own muted treatment (dashed border plus
an `--ink2` "Coming" marker) rather than a transplanted style. Nothing decorative
is added and the signature flow line is withheld. What changed from the brief: the
token names, corrected to the repo's real ones.
