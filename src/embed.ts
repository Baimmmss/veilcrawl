import { join } from 'node:path';
import { homeDir } from './store.ts';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DIMS = 384;

type Extractor = (texts: string[], options: object) => Promise<{ data: Float32Array }>;
let loading: Promise<Extractor | null> | undefined;

async function load(): Promise<Extractor | null> {
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = join(homeDir(), 'models');
    return (await pipeline('feature-extraction', MODEL, { dtype: 'q8' })) as unknown as Extractor;
  } catch (error) {
    // Optional: the package may be left out, or the model download may fail. Keyword search still works.
    console.error(`VeilCrawl semantic search is off: ${(error as Error).message}`);
    return null;
  }
}

/** Unit-length sentence vectors, DIMS numbers per text one after another, or null when semantic search is off or unavailable. */
export async function embed(texts: string[]): Promise<Float32Array | null> {
  if (process.env.VEILCRAWL_SEMANTIC === 'off' || !texts.length) return null;
  const extractor = await (loading ??= load());
  if (!extractor) return null;
  const vectors = new Float32Array(texts.length * DIMS);
  for (let i = 0; i < texts.length; i += 64) vectors.set((await extractor(texts.slice(i, i + 64), { pooling: 'mean', normalize: true })).data, i * DIMS);
  return vectors;
}
