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

/* ------------------------------------------------------------------ */
/* sharpness: variance-of-Laplacian estimate via sharp stats            */
/* ------------------------------------------------------------------ */
async function sharpness(buffer) {
  const sharpModule = (await import("sharp")).default;
  const { stats } = await sharpModule(buffer)
    .greyscale()
    .stats();
  // Higher variance within a luma channel ≈ more edges ≈ sharper frame
  return stats.channels[0].stdev;
}

/* ------------------------------------------------------------------ */
/* image optimisation to WebP ≤ 200 KB                                   */
/* ------------------------------------------------------------------ */
export async function optimiseImage(buffer, { minQuality = 38, maxWidth = 1200 } = {}) {
  const sharpModule = (await import("sharp")).default;
  let quality = 82;
  let width = maxWidth;
  let out = null;
  while (width >= 560) {
    while (quality >= minQuality) {
      out = await sharpModule(buffer)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality, effort: 4 })
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

  // 3. Score sharpness, sort, optimise to WebP
  const sharpModule = (await import("sharp")).default;
  const scored = await Promise.all(
    frameFiles.map(async (file, i) => {
      const jpeg = fs.readFileSync(file);
      const score = await sharpness(jpeg).catch(() => 0);
      const webp = await optimiseImage(jpeg);
      return { i, score, webp: webp ?? (await sharpModule(jpeg).webp({ quality: 65 }).toBuffer()) };
    }),
  );
  scored.sort((a, b) => b.score - a.score);

  // best frame first, then remaining in their original temporal order
  const best = scored[0];
  const rest = scored.slice(1).sort((a, b) => a.i - b.i);

  // 4. Transcode to a lighter mp4 if the source is bulky (720p, CRF 28, AAC ~96k)
  let videoOut = buffer;
  if (buffer.length > transcodeAboveMB * 1024 * 1024) {
    const out = path.join(TMP, `light-${id}.mp4`);
    try {
      await run(
        ffmpegPath,
        ["-y", "-i", input, "-vf", "scale='min(720,iw)':-2", "-pix_fmt", "yuv420p",
         "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-movflags", "+faststart",
         "-c:a", "aac", "-b:a", "96k", out],
        { timeout: 120000 },
      );
      if (fs.existsSync(out) && fs.statSync(out).size > 0) videoOut = fs.readFileSync(out);
    } catch {
      videoOut = buffer;
    }
  }

  // 5. cleanup
  for (const f of [input, ...frameFiles]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }

  return {
    videoBuffer: videoOut,
    frames: [best, ...rest].map((f) => f.webp),
    bestIndex: 0, // best is always index 0 after ordering
  };
}

/* ------------------------------------------------------------------ */
/* multi-image: blur-dedupe + preserve order                            */
/* ------------------------------------------------------------------ */
export async function processImages(buffers) {
  const sharpModule = (await import("sharp")).default;
  if (!buffers.length) return [];

  const processed = await Promise.all(
    buffers.map(async (buf, index) => {
      const score = await sharpness(buf).catch(() => 0);
      const hash = crypto.createHash("sha1").update(buf).digest("hex");
      const webp = await optimiseImage(buf);
      return { index, score, hash, webp: webp ?? (await sharpModule(buf).webp({ quality: 60 }).toBuffer()) };
    }),
  );

  const kept = [];
  const seen = new Set();
  for (const item of processed) {
    if (seen.has(item.hash)) continue;               // exact same image twice
    seen.add(item.hash);
    kept.push(item);
  }

  // If ALL frames are low-sharpness keep them anyway (bad > none); otherwise drop
  // frames that are distinctly blurrier than the best frame we have.
  const bestScore = Math.max(...kept.map((k) => k.score));
  const refined = kept.filter((k) => k.score >= bestScore * 0.35);

  // Preserve original order for the gallery (index asc)
  return refined.sort((a, b) => a.index - b.index).map((k) => k.webp);
}

const mediaEngine = { optimiseImage, processVideo, processImages, sharpness };

export default mediaEngine;
