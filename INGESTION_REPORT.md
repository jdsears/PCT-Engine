# Ingestion run report

Phase 1 of the PCT Knowledge Co-Pilot. The Richards and PCT corpora have been
extracted, chunked, embedded at vector(1024) through Voyage, and written to
kb_chunks. This report records the state at the end of the run so the retrieval
brief can start from a known position.

## Totals

- 15,520 chunks across 528 documents.
- richards: 499 documents, 13,449 chunks.
- pct: 29 documents, 2,071 chunks.

## Richards chunks by line

| line            | chunks |
| --------------- | ------ |
| jordan          | 3,771  |
| steriflow       | 3,074  |
| marwin          | 2,075  |
| low_flow        | 1,928  |
| hexvalve        | 836    |
| steriflow_fb    | 818    |
| equilibar       | 663    |
| bestobell_steam | 238    |
| Data Centres and root | 46 |

All eight product lines are present, along with the Data Centres application
material and the root overview deck.

## PCT chunks by folder

| folder              | chunks |
| ------------------- | ------ |
| Reference Documents | 1,832  |
| Policies            | 155    |
| Company Information  | 72     |
| Certificates        | 12     |

## Content shape

- By source type: product_datasheet 10,573, product_table 2,869,
  company_overview 2,057, company_table 14, overview 7.
- By content type: prose 12,637, table 2,883.

## Files with no extractable text

Four files yielded no usable text and were skipped. None of these blocked the
run.

- 1. Jordan Valve/Commercial Information/Sales Aids/weight and power adv of SG valves.ppt
- 2. Steriflow/Commercial Information/Battle Cards/MK93TH-Competitive-Comparison.pdf
- 2. Steriflow/Commercial Information/Competitive Info/MK93TH comp comparison updated  5-3-2017.pdf
- Policies/External Sales Process Policy.docx (pct)

The .ppt is the legacy PowerPoint format, which the Office parser does not read.
The two Steriflow PDFs appear to be image-only comparison sheets with little or
no text layer.

## Spot checks

- "who is PCT" against the pct corpus returns the Mission and Vision and Company
  Values document first, at a score of 0.42, then the privacy policy and the
  terms of sale. This reads correctly.
- "CV3000 pressure rating" against the richards corpus returns generic pressure
  and flow-coefficient tables, an Equilibar Series 3000 table, a Low Flow MK8000
  table, and a Jordan Cv table. The Marwin CV3000 datasheet is in the corpus
  with 99 chunks but did not rank in the top three. A plain vector search reads
  CV3000 as Cv plus 3000, so model-code queries will need keyword or hybrid
  search. This is for the retrieval brief.

## Notes for the cleanup and retrieval brief

These do not block Phase 1 but should be handled before the chat layer.

1. Duplicate documents. The Marwin folder files the same datasheets under
   several category subfolders, so documents such as CV3000.pdf, MS3000.pdf,
   3000-Full.pdf and 4700-Full.pdf are ingested several times each. There are
   also A4 and non-A4 pairs of the same catalogue, for example steriflowcc and
   steriflowcc_a4, and LowFlowCC and LowFlowCC_A4. The walker keys on the file
   path, so byte-identical copies at different paths are treated as separate
   documents. A content-hash dedup at ingestion, keeping one copy per hash,
   would remove this.
2. High-chunk outliers. Two documents dominate their corpus with low-value
   text: Sales Areas - Map (High Detail).pdf produced 1,736 chunks of postcode
   labels, and LowFlowCC_A4.pdf produced 1,032. These are worth excluding or
   summarising rather than chunking in full.
3. Model-code retrieval, as in the CV3000 spot check above.
