/**
 * Face engine: turns a photo into a face embedding ("fingerprint") and compares two of them.
 *
 * Uses @vladmandic/human (open-source models shipped inside the npm package) on the
 * TensorFlow.js WebAssembly backend, so it needs no native build and runs on any server.
 * The model is loaded once, on first use (about a second); each photo then takes ~0.3 s.
 * Nothing is sent to any external service.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import jpeg from 'jpeg-js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

export interface FaceReading {
  /** Faces found in the photo. Only exactly one can be matched. */
  faces: number;
  embedding: number[] | null;
  /** Detector confidence 0–1. */
  score: number | null;
  /** Anti-spoofing / liveness estimates 0–1. Recorded for review only; not used to decide. */
  real: number | null;
  live: number | null;
}

const require = createRequire(import.meta.url);
let loading: Promise<any> | null = null;

/** A package's root folder. Their "exports" maps expose neither package.json nor the files we need. */
function packageDir(name: string) {
  let dir = path.dirname(require.resolve(name));
  while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  return dir;
}

async function human() {
  loading ??= (async () => {
    // Node's fetch cannot read file:// URLs, and the models are files inside the package.
    const netFetch = globalThis.fetch;
    if (!(netFetch as any).__geoattendFile) {
      const patched = (async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : (input?.url ?? String(input));
        if (url.startsWith('file:')) return new Response(await fs.promises.readFile(new URL(url)), { status: 200 });
        return netFetch(input, init);
      }) as typeof fetch & { __geoattendFile?: boolean };
      patched.__geoattendFile = true;
      globalThis.fetch = patched;
    }
    const root = packageDir('@vladmandic/human');
    const { Human } = require(path.join(root, 'dist', 'human.node-wasm.js'));
    const h = new Human({
      backend: 'wasm',
      wasmPath: pathToFileURL(path.join(packageDir('@tensorflow/tfjs-backend-wasm'), 'dist') + path.sep).href,
      modelBasePath: pathToFileURL(path.join(root, 'models') + path.sep).href,
      debug: false,
      face: {
        enabled: true,
        detector: { rotation: true, maxDetected: 3, minConfidence: 0.4 },
        mesh: { enabled: true },
        iris: { enabled: false },
        description: { enabled: true },
        emotion: { enabled: false },
        antispoof: { enabled: true },
        liveness: { enabled: true },
      },
      body: { enabled: false },
      hand: { enabled: false },
      object: { enabled: false },
      gesture: { enabled: false },
      segmentation: { enabled: false },
    });
    const t0 = Date.now();
    await h.load();
    logger.info({ ms: Date.now() - t0 }, 'face engine loaded');
    return h;
  })().catch((err) => {
    loading = null; // retry on the next call
    throw err;
  });
  return loading;
}

export const MODEL_NAME = 'human-faceres-3.3';

/** Pluggable so tests can supply a deterministic engine. */
export const faceEngine = {
  enabled: () => config.faceMatch.provider === 'local',

  async read(photo: Buffer): Promise<FaceReading> {
    const h = await human();
    // Phones send JPEG; anything else cannot be decoded here and is treated as "no face".
    if (!(photo[0] === 0xff && photo[1] === 0xd8)) return { faces: 0, embedding: null, score: null, real: null, live: null };
    const img = jpeg.decode(photo, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 256, maxResolutionInMP: 40 });
    const t3 = h.tf.tensor3d(img.data, [img.height, img.width, 3], 'int32');
    const t4 = h.tf.expandDims(t3, 0);
    try {
      const r = await h.detect(t4);
      const f = r.face[0];
      return {
        faces: r.face.length,
        embedding: r.face.length === 1 && f?.embedding?.length ? Array.from(f.embedding as number[]) : null,
        score: f?.score ?? null,
        real: f?.real ?? null,
        live: f?.live ?? null,
      };
    } finally {
      h.tf.dispose([t3, t4]);
    }
  },

  /** Similarity 0–1 between two embeddings (same person ≈ 0.6–0.9, different people usually < 0.3). */
  async similarity(a: number[], b: number[]): Promise<number> {
    const h = await human();
    return h.match.similarity(a, b);
  },
};

/** Best similarity of a photo's embedding against any of the enrolled ones, in % (0–100). */
export async function bestMatch(embedding: number[], enrolled: number[][]) {
  let best = 0;
  for (const e of enrolled) best = Math.max(best, await faceEngine.similarity(embedding, e));
  return Math.round(best * 1000) / 10;
}
