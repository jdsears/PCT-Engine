const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = process.env.VOYAGE_MODEL || 'voyage-3.5'; // voyage-3-large for top-end quality
const DIM = 1024;

// Embed an array of strings. inputType is 'document' for indexing, 'query' for search.
export async function embedTexts(texts, inputType = 'document') {
  if (texts.length === 0) return [];
  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: texts, model: MODEL, input_type: inputType, output_dimension: DIM }),
  });
  if (!res.ok) throw new Error(`Voyage embed failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}
