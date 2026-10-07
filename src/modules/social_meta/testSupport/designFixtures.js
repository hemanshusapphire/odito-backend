/**
 * Test-only fixtures for AI design generation: REAL image bytes made with sharp (so the real media pipeline
 * runs on real pixels), a scripted image provider, and an OpenAI Images API response builder. Nothing here is
 * used at runtime.
 */
import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';

/** A real image of the given size/format with a random flat colour (so two generations never share bytes). */
export async function makeImage({ width = 1024, height = 1024, format = 'png', background } = {}) {
  const color = background || { r: Math.floor(Math.random() * 200) + 30, g: Math.floor(Math.random() * 200) + 30, b: Math.floor(Math.random() * 200) + 30 };
  let pipeline = sharp({ create: { width, height, channels: 3, background: color } });
  if (format === 'jpeg') pipeline = pipeline.withMetadata({ exif: { IFD0: { Copyright: 'SECRET-EXIF-MARKER' } } }).jpeg();
  else if (format === 'webp') pipeline = pipeline.webp();
  else pipeline = pipeline.png();
  return pipeline.toBuffer();
}

const parseSize = (size) => { const [w, h] = String(size).split('x').map(Number); return { width: w || 1024, height: h || 1024 }; };

/** Scripted image provider with the same contract as OpenAIImageProvider (isAvailable / generateImage). */
export function mockImageProvider({ behavior = null, available = true, gate = null, model = 'mock-image-model' } = {}) {
  const calls = [];
  return {
    calls,
    isAvailable: () => available,
    async generateImage({ prompt, size, generationId, referenceImages }) {
      calls.push({ prompt, size, generationId, referenceImages });
      if (gate) await gate;
      const buffer = behavior ? await behavior({ prompt, size, callNumber: calls.length }) : await makeImage({ ...parseSize(size), format: 'png' });
      return { buffer, usage: { inputTokens: 30, outputTokens: 1_000 }, model, durationMs: 5, attempts: 1 };
    },
  };
}

/** An OpenAI Images API response body carrying `buffer` as base64. */
export const imagesResponseBody = (buffer, { usage = { input_tokens: 60, output_tokens: 1056, total_tokens: 1116 } } = {}) => ({
  created: 1_760_000_000, data: [{ b64_json: buffer.toString('base64') }], output_format: 'jpeg', quality: 'medium', size: '1024x1024', usage,
});

/** Removes the files a test stored for a project (storage/social_media/<projectId>). */
export async function removeProjectMedia(projectId) {
  await fs.rm(path.resolve(process.cwd(), 'storage', 'social_media', String(projectId)), { recursive: true, force: true });
}

/** Files currently stored for a project. */
export async function listProjectMedia(projectId) {
  try { return await fs.readdir(path.resolve(process.cwd(), 'storage', 'social_media', String(projectId))); } catch { return []; }
}
