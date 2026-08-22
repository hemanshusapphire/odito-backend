import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getServiceUrls } from '../../../../config/env.js';
import { isPubliclyReachableUrl } from '../../../../utils/publicUrlCheck.js';

/**
 * MediaStorageService — the ONLY place that writes/deletes a social-post
 * media file, behind a small provider-agnostic interface
 * (upload/deleteByUrl/isOwnedUrl). Local disk today, matching the ONLY
 * upload pattern that already exists anywhere in Odito (authService.js's
 * avatar storage: files under storage/<feature>/, served by server.js's
 * existing `app.use('/storage', express.static(...))` — no new static
 * route, no new storage provider). No S3/Cloudinary/R2 SDK exists in
 * odito_backend/package.json, so introducing one here would be a second,
 * redundant storage system; swapping to a real object store later only
 * means replacing this one file — nothing above it (the upload
 * controller, the platform adapters) knows or cares how a URL was made.
 */

const ROOT_DIR = path.resolve(process.cwd(), 'storage', 'social_media');

function urlPrefix() {
  // Computed lazily (not at module load) so it always reads BACKEND_URL
  // from whatever env state exists at call time — same reasoning as
  // authService.js's getAvatarUrlPrefix(). This is also what makes a media
  // URL usable by Meta at all: Meta's Graph API fetches image_url/
  // video_url from the public internet, so BACKEND_URL must be a real,
  // publicly reachable HTTPS origin in any environment where a live Meta
  // publish is expected to work (not the case for a local dev machine —
  // see this phase's own "manual setup required" note).
  const { backend } = getServiceUrls();
  return `${backend}/storage/social_media/`;
}

/** True only for a URL this service itself wrote — the sole gate before any delete is attempted. */
export function isOwnedUrl(url) {
  return typeof url === 'string' && url.startsWith(urlPrefix());
}

// isPubliclyReachableUrl is re-exported from utils/publicUrlCheck.js (the
// single authoritative definition, also used by config/env.js's startup
// validation) — kept as a named re-export here so every existing importer
// in this module (platformAdapters/facebookAdapter.js, instagramAdapter.js,
// this file's own tests) is unaffected.
export { isPubliclyReachableUrl };

/**
 * Resolves a public URL this service issued back to its real file path,
 * rejecting anything that isn't exactly "<24-hex-projectId>/<filename>" —
 * defense in depth against path traversal, even though in practice the
 * project-id segment only ever came from a validated ObjectId and the
 * filename only ever came from randomUUID() (see upload() below), never
 * from user input.
 */
function safeFilePath(url) {
  const rel = url.slice(urlPrefix().length);
  const segments = rel.split('/');
  if (segments.length !== 2) return null;
  const [projectSegment, filename] = segments;
  if (!/^[a-f0-9]{24}$/i.test(projectSegment)) return null;
  if (!filename || filename.includes('..') || filename.includes('\\') || filename.includes('/')) return null;
  return path.join(ROOT_DIR, projectSegment, filename);
}

/**
 * Writes `buffer` under storage/social_media/<projectId>/<uuid><extension>
 * and returns its public HTTPS URL. Scoped per PROJECT (never per-user or
 * globally) — matching this module's existing isolation discipline
 * (SocialPublication, SocialAccount are both project_id-scoped). The
 * filename is always a fresh UUID; the original client filename is never
 * read or reused anywhere in this path.
 */
export async function upload({ buffer, projectId, extension }) {
  const dir = path.join(ROOT_DIR, String(projectId));
  await fs.mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}${extension}`;
  await fs.writeFile(path.join(dir, filename), buffer);
  return { url: `${urlPrefix()}${projectId}/${filename}`, filename };
}

/**
 * Best-effort delete — never throws (logs internally); ENOENT (already
 * gone) is silently ignored, same discipline as authService.js's
 * deleteOwnedAvatarFile.
 */
export async function deleteByUrl(url) {
  if (!isOwnedUrl(url)) return;
  const filePath = safeFilePath(url);
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[MEDIA_STORAGE] Failed to delete media file:', error.message);
    }
  }
}

export default { upload, deleteByUrl, isOwnedUrl, isPubliclyReachableUrl };
