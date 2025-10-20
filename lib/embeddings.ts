const EMBEDDING_API_URL =
  process.env.OPENAI_EMBEDDINGS_URL ?? "https://api.openai.com/v1/embeddings";
const DEFAULT_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-large";
const DEFAULT_MAX_EMBEDDING_CHARS = 32_000;
const MAX_EMBEDDING_CHARS = (() => {
  const value = process.env.OPENAI_EMBEDDING_MAX_CHARS
    ? Number(process.env.OPENAI_EMBEDDING_MAX_CHARS)
    : Number.NaN;
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_MAX_EMBEDDING_CHARS;
})();

type EmbeddingResponse = {
  data: Array<{
    embedding: number[];
  }>;
};

export async function generateEmbeddingVector(input: string) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn(
      "OPENAI_API_KEY is not configured. Skipping embedding generation."
    );
    return null;
  }

  const trimmed = input.trim();

  if (!trimmed) {
    return null;
  }

  let prepared = trimmed;

  if (prepared.length > MAX_EMBEDDING_CHARS) {
    prepared = prepared.slice(0, MAX_EMBEDDING_CHARS);
    console.warn(
      `Embedding input truncated from ${trimmed.length} to ${prepared.length} characters to satisfy model limits.`
    );
  }

  const response = await fetch(EMBEDDING_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_EMBEDDING_MODEL,
      input: prepared,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `OpenAI embedding error (${response.status}): ${
        detail || response.statusText
      }`
    );
  }

  const payload = (await response.json()) as EmbeddingResponse;
  const embedding = payload.data?.[0]?.embedding;

  if (!embedding) {
    throw new Error("OpenAI embedding response did not include vector data");
  }

  return embedding;
}

export function cosineSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length) {
    throw new Error("Embedding vectors must be the same length to compare");
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
