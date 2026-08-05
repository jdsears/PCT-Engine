# Known gaps

Conditions the engine knows about, has decided not to fix yet, and should not
rediscover later as if they were new. Each entry states the gap, why it stands,
and the options for closing it.

## The food and beverage campaign is scheduled, not built

**The plan.** John, 5 August 2026: the food and bev campaign comes in
September, run by Andy alongside his pharma LinkedIn lane. It is deliberately
not in the engine yet. The ground is prepared: the 46 food, beverage and
cosmetics customers from James's segmented list are on the register with
customer grades, the campaign machinery is fully definition-driven, and the
pharma definition is the template. When September comes it is one definition
file at status manual, first sweep held as John's calibration event, the same
path pharma took. Until then nothing sweeps, drafts or posts for this segment.

## The Marwin brass and three-way ranges hold no co-pilot text

**The gap.** The source PDFs for these ranges (the Marwin brass valve sheets,
the three-way sheets, the Steriflow white paper and the other scanned
documents) are image-only scans with no text layer. The document sync extracts
nothing from them and reports "no extractable text", which is correct
behaviour, not a bug: there is no text to find. They are acknowledged in
`src/sync/acknowledgements.json` so the Health page reports them calmly.

**What this costs.** The co-pilot holds no text for those ranges, so it will
decline questions about them. That is the honest behaviour the corpus rules
demand, since it answers only from documents it holds, but it is unhelpful to
a rep who expects an answer.

**What it does not cost.** The ordering side is unaffected. Those matrices were
captured another way and the configurator builds part numbers for these ranges
normally, so a rep can still configure and price them. The gap is knowledge
questions, not configuration.

**Two ways to close it, a decision waiting.**

1. **Text-based copies from Richards.** Ask Richards for the same sheets as
   text-bearing PDFs or source documents. Cleanest result, since the text is
   the manufacturer's own and carries no transcription risk, but it depends on
   Richards having them and sending them.
2. **OCR at ingest.** Add an OCR pass in the sync for documents that extract to
   nothing. Self-service and covers future scans as well, but OCR output on
   technical tables is imperfect, and a mis-read figure entering the corpus is
   a worse failure than a decline, given the co-pilot quotes what it holds. It
   would need a confidence rule and probably a human check before anything
   OCR'd is served.

The first option is preferred where Richards can supply the files, on the same
principle that governs the configurator: transcribe what the manufacturer
printed, never reconstruct it. No work is scheduled on either; this is recorded
so the choice is made once, deliberately, rather than rediscovered.
