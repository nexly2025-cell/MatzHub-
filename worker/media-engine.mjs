#!/usr/bin/env node
/**
 * Media engine for the WhatsApp worker. Zero recurring cost — ffmpeg + sharp
 * run locally on the worker container. No AI APIs are required for thumbnails,
 * blur scoring, or dedupe; an OPTIONAL vision pass can be swapped in later.
 *
 * Footwear & watches (suppliers mostly send videos):
 *   video → N candidate frames (sharpness-scored) → best = cover, video kept.
 * Bags, clothing, everything else (suppliers send 2–4 photos):
 *   images in original order preserved, first = cover, duplicates and blurred
 *   frames dropped if better alternatives exist.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

let ffmpegPath = null;
try {
  ffmpegPath = (await import("ffmpeg-static")).default;
} catch {
  ffmpegPath = null;
}

const TMP = path.join(process.cwd(), ".media-tmp");
fs.mkdirSync(TMP, { recursive: true });

const WORKERTIMEOUT = 30000;

export const MIN_IMAGE_DIMENSION = 160;
export const MAX_ASPECT_RATIO = 4.0;
export const MIN_LUMA_STDEV = 3.5;
export const MIN_USABLE_SHARPNESS = 3.5;

/* ------------------------------------------------------------------ */
/* sharpness: true 2D Laplacian standard deviation via sharp raw buffer */
/* ------------------------------------------------------------------ */
export async function sharpness(buffer) {
  const sharpModule = (await import("sharp")).default;
  const pipeline = sharpModule(buffer)
    .rotate()
    .greyscale()
    .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true });
  if (typeof pipeline.raw === "function") {
    try {
      const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
      const w = info.width;
      const h = info.height;
      if (w >= 3 && h >= 3) {
        let sum = 0;
        let sq = 0;
        let count = 0;
        for (let y = 1; y < h - 1; y += 1) {
          const row = y * w;
          for (let x = 1; x < w - 1; x += 1) {
            const idx = row + x;
            const lap = data[idx - w] + data[idx + w] + data[idx - 1] + data[idx + 1] - 4 * data[idx];
            sum += lap;
            sq += lap * lap;
            count += 1;
          }
        }
        if (count > 0) {
          const mean = sum / count;
          return Math.sqrt(Math.max(0, sq / count - mean * mean));
        }
      }
    } catch {
      /* fallback to channel stdev if raw extraction is mocked */
    }
  }
  const stats = await sharpModule(buffer).greyscale().stats();
  return stats.channels[0].stdev;
}

/**
 * Deterministic image quality & usability check (zero API cost).
 * Rejects corrupt buffers, tiny icons, extreme text-banner strips, blank/solid
 * frames, and severely blurred captures without touching valid product images.
 */
export async function assessImageQuality(buffer, { minDimension = MIN_IMAGE_DIMENSION, minSharpness = MIN_USABLE_SHARPNESS } = {}) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 128) {
    return { usable: false, width: 0, height: 0, sharpness: 0, lumaStdev: 0, reason: "empty_or_corrupt_buffer" };
  }
  try {
    const sharpModule = (await import("sharp")).default;
    const meta = await sharpModule(buffer).metadata();
    const width = Number(meta.width || 0);
    const height = Number(meta.height || 0);
    if (!width || !height) {
      return { usable: false, width: 0, height: 0, sharpness: 0, lumaStdev: 0, reason: "invalid_dimensions" };
    }
    if (width < minDimension || height < minDimension) {
      return { usable: false, width, height, sharpness: 0, lumaStdev: 0, reason: "resolution_too_low" };
    }
    const aspect = width / height;
    if (aspect > MAX_ASPECT_RATIO || aspect < 1 / MAX_ASPECT_RATIO) {
      return { usable: false, width, height, sharpness: 0, lumaStdev: 0, reason: "extreme_aspect_ratio" };
    }
    const lumaStats = await sharpModule(buffer).rotate().greyscale().stats();
    const lumaStdev = lumaStats.channels[0]?.stdev ?? 0;
    if (lumaStdev < MIN_LUMA_STDEV) {
      return { usable: false, width, height, sharpness: 0, lumaStdev, reason: "blank_or_uniform_frame" };
    }
    const edgeScore = await sharpness(buffer);
    if (edgeScore < minSharpness) {
      return { usable: false, width, height, sharpness: edgeScore, lumaStdev, reason: "blurry_frame" };
    }
    return { usable: true, width, height, sharpness: edgeScore, lumaStdev, reason: null };
  } catch {
    return { usable: false, width: 0, height: 0, sharpness: 0, lumaStdev: 0, reason: "unreadable_image" };
  }
}

/* ------------------------------------------------------------------ */
/* Safe deterministic cleanup & optimisation to WebP ≤ 200 KB           */
/* Preserves exact product shape, proportions, colour, and details.     */
/* ------------------------------------------------------------------ */
export async function optimiseImage(buffer, { minQuality = 46, maxWidth = 1200, trimBorders = true } = {}) {
  const sharpModule = (await import("sharp")).default;
  let sourceBuffer = buffer;

  // Safe border whitespace/letterbox trim: ONLY keep the trim if it preserves
  // at least 75% of both width and height, guaranteeing we never crop into the product.
  if (trimBorders) {
    try {
      const meta = await sharpModule(buffer).rotate().metadata();
      if (meta.width && meta.height && typeof sharpModule(buffer).trim === "function") {
        const trimmed = await sharpModule(buffer)
          .rotate()
          .trim({ threshold: 8 })
          .toBuffer({ resolveWithObject: true });
        if (
          trimmed.info.width >= meta.width * 0.75 &&
          trimmed.info.height >= meta.height * 0.75 &&
          trimmed.info.width >= MIN_IMAGE_DIMENSION &&
          trimmed.info.height >= MIN_IMAGE_DIMENSION
        ) {
          sourceBuffer = trimmed.data;
        }
      }
    } catch {
      sourceBuffer = buffer;
    }
  }

  let quality = 84;
  let width = maxWidth;
  let out = null;
  while (width >= 640) {
    while (quality >= minQuality) {
      out = await sharpModule(sourceBuffer)
        .rotate()
        .resize({ width, withoutEnlargement: true, fit: "inside" })
        .webp({ quality, effort: 4, smartSubsample: true })
        .toBuffer();
      if (out.length <= 200 * 1024) return out;
      quality -= 6;
    }
    width -= 120;
    quality = 80;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Category-aware frame budget                                         */
/* ------------------------------------------------------------------ */
/**
 * How many candidate frames to pull from a video, per category. A watch or
 * pair of sunglasses is one static object filmed from one or two angles, so a
 * single sharp still plus the video is the complete listing; footwear and
 * apparel are shot from several sides so more candidates help. Maxima, not
 * targets: the sharpness filter still drops blurry/duplicate frames.
 */
export const FRAME_BUDGET = Object.freeze({
  watches: 1,
  sunglasses: 1,
  perfumes: 2,
  handbags: 2,
  footwear: 3,
  apparel: 3,
});

export function framesForCategory(category) {
  const key = String(category || "").toLowerCase().trim();
  return FRAME_BUDGET[key] ?? 2;
}

/* video: extract candidate frames, transcode light mp4                 */
/* ------------------------------------------------------------------ */
export async function processVideo(buffer, { frames = 4, transcodeAboveMB = 12 } = {}) {
  if (!ffmpegPath) throw new Error("ffmpeg unavailable (install ffmpeg-static in worker)");

  const id = crypto.randomBytes(6).toString("hex");
  const input = path.join(TMP, `in-${id}.mp4`);
  fs.writeFileSync(input, buffer);

  // 1. Duration via ffprobe
  let durationSec = 3;
  try {
    const probe = path.join(path.dirname(ffmpegPath), `ffprobe${process.platform === "win32" ? ".exe" : ""}`);
    const { stdout } = await run(probe, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", input,
    ]);
    durationSec = Math.max(0.5, parseFloat(stdout) || 3);
  } catch {
    /* fall back to scene-based grab */
  }

  // 2. Extract evenly spaced frames
  const frameFiles = [];
  for (let i = 0; i < frames; i += 1) {
    const t = durationSec * ((i + 1) / (frames + 1));
    const out = path.join(TMP, `frame-${id}-${i}.jpg`);
    await run(ffmpegPath, ["-y", "-ss", String(t.toFixed(2)), "-i", input, "-frames:v", "1", "-q:v", "3", out], { timeout: WORKERTIMEOUT });
    if (fs.existsSync(out)) frameFiles.push(out);
  }

  // 3. Assess quality, filter unusable/blurry frames, sort, and optimise to WebP
  const sharpModule = (await import("sharp")).default;
  const scored = await Promise.all(
    frameFiles.map(async (file, i) => {
      const jpeg = fs.readFileSync(file);
      const quality = await assessImageQuality(jpeg);
      if (!quality.usable) return null;
      const hash = crypto.createHash("sha1").update(jpeg).digest("hex");
      const webp = await optimiseImage(jpeg);
      return {
        i,
        hash,
        score: quality.sharpness,
        webp: webp ?? (await sharpModule(jpeg).webp({ quality: 65 }).toBuffer()),
      };
    }),
  );

  const usableFrames = [];
  const seenFrameHashes = new Set();
  for (const item of scored) {
    if (!item || seenFrameHashes.has(item.hash)) continue;
    seenFrameHashes.add(item.hash);
    usableFrames.push(item);
  }

  usableFrames.sort((a, b) => b.score - a.score);
  const topScore = usableFrames[0]?.score ?? 0;
  const cleanFrames = usableFrames.filter((f) => f.score >= topScore * 0.45);

  // best frame first, then remaining clean frames in their original temporal order
  const best = cleanFrames[0];
  const rest = cleanFrames.slice(1).sort((a, b) => a.i - b.i);

  // 4. Transcode to a lighter mp4 if the source is bulky (720p, CRF 28, AAC ~96k)
  let videoOut = buffer;
  const lightOut = path.join(TMP, `light-${id}.mp4`);
  if (buffer.length > transcodeAboveMB * 1024 * 1024) {
    try {
      await run(
        ffmpegPath,
        ["-y", "-i", input, "-vf", "scale='min(720,iw)':-2", "-pix_fmt", "yuv420p",
         "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-movflags", "+faststart",
         "-c:a", "aac", "-b:a", "96k", lightOut],
        { timeout: 120000 },
      );
      if (fs.existsSync(lightOut) && fs.statSync(lightOut).size > 0) videoOut = fs.readFileSync(lightOut);
    } catch {
      videoOut = buffer;
    }
  }

  // 5. cleanup
  for (const f of [input, lightOut, ...frameFiles]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }

  return {
    videoBuffer: videoOut,
    frames: best ? [best, ...rest].map((f) => f.webp) : [],
    bestIndex: 0, // best is always index 0 after ordering
  };
}

/* ------------------------------------------------------------------ */
/* multi-image: quality check + blur-dedupe + best cover selection      */
/* ------------------------------------------------------------------ */
export async function processImages(buffers) {
  const sharpModule = (await import("sharp")).default;
  if (!Array.isArray(buffers) || !buffers.length) return [];

  const processed = await Promise.all(
    buffers.map(async (buf, index) => {
      const quality = await assessImageQuality(buf);
      if (!quality.usable) return null;
      const hash = crypto.createHash("sha1").update(buf).digest("hex");
      const webp = await optimiseImage(buf);
      return {
        index,
        score: quality.sharpness,
        hash,
        webp: webp ?? (await sharpModule(buf).webp({ quality: 65 }).toBuffer()),
      };
    }),
  );

  const kept = [];
  const seen = new Set();
  for (const item of processed) {
    if (!item) continue;
    if (seen.has(item.hash)) continue; // exact same image twice
    seen.add(item.hash);
    kept.push(item);
  }

  // Never publish unusable/blurry representations: if no frame passed quality
  // checks, return [] so ingestion routes the listing to review.
  if (!kept.length) return [];

  const bestScore = Math.max(...kept.map((k) => k.score));
  const refined = kept.filter((k) => k.score >= bestScore * 0.35);

  // Order by original sequence, but if the first image is significantly blurrier
  // than the sharpest view in the set, promote the sharpest view to cover (index 0).
  const ordered = refined.sort((a, b) => a.index - b.index);
  if (ordered.length > 1 && ordered[0].score < bestScore * 0.6) {
    const sharpestIdx = ordered.findIndex((item) => item.score === bestScore);
    if (sharpestIdx > 0) {
      const [sharpest] = ordered.splice(sharpestIdx, 1);
      ordered.unshift(sharpest);
    }
  }

  return ordered.map((k) => k.webp);
}

/**
 * Issue 1 — never persist signed URLs. They expire in ~1 hour and break
 * 40–60% of catalogue images for returning visitors.
 */
export function getPublicUrl(supabaseUrl, bucket, objectPath) {
  const base = String(supabaseUrl || "").replace(/\/$/, "");
  const clean = String(objectPath || "").replace(/^\/+/, "");
  if (!base || !bucket || !clean) return "";
  return `${base}/storage/v1/object/public/${bucket}/${clean}`;
}

export function toPublicUrl(url) {
  if (!url || typeof url !== "string") return url;
  let next = url
    .replace("/storage/v1/object/sign/", "/storage/v1/object/public/")
    .replace("/storage/v1/object/authenticated/", "/storage/v1/object/public/");
  try {
    const parsed = new URL(next);
    parsed.searchParams.delete("token");
    return parsed.toString();
  } catch {
    return next.split("?")[0];
  }
}

const mediaEngine = {
  optimiseImage,
  processVideo,
  processImages,
  sharpness,
  assessImageQuality,
  framesForCategory,
  getPublicUrl,
  toPublicUrl,
};

export default mediaEngine;
