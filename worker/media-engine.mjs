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

// Resolved lazily so this module can also be imported by the Next.js app
// (existing-product background backfill) where ffmpeg is not installed and the
// working directory may be read-only. The worker behaviour is unchanged.
let ffmpegPath;
async function resolveFfmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  try {
    const specifier = "ffmpeg-static";
    ffmpegPath = (await import(/* webpackIgnore: true */ specifier)).default ?? null;
  } catch {
    ffmpegPath = null;
  }
  return ffmpegPath;
}

const TMP = path.join(process.cwd(), ".media-tmp");

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
/* TRUE background cleanup — deterministic, product-preserving          */
/* ------------------------------------------------------------------ */
export const BG_BORDER_AGREEMENT = 0.9; // share of border pixels that must match the backdrop
export const BG_GLOBAL_TOLERANCE = 40; // RGB distance from backdrop colour
export const BG_STEP_TOLERANCE = 8; // max neighbour-to-neighbour change while flooding (stops leaks through soft edges)
export const BG_PROTECT_PX = 2; // background pixels this close to the product keep their source values
export const BG_FEATHER_PX = 4; // then blend backdrop → white over this many px (background pixels only)
export const BG_LIGHT_BACKDROP = 230; // min channel at/above which the backdrop is left alone
export const BG_MAX_BACKDROP_LIKE_PRODUCT = 0.01; // share of interior product pixels allowed to match the backdrop colour
export const BG_MIN_SOLIDITY = 0.85; // product area / convex-hull area; lower = possible leak into product
const BG_MAX_SIDE = 2400;

/**
 * Removes the backdrop around a product and replaces it with pure white.
 *
 * This is real background removal, not border cropping: backdrop pixels are
 * found by an edge-seeded, gradient-limited flood fill and repainted, anywhere
 * in the frame (including shadows/gradients around the product).
 *
 * Product-preservation guarantees (enforced, not assumed):
 * - Pixels classified as product are copied byte-for-byte from the source;
 *   geometry, colour, texture, logos, stitching and hardware are never
 *   touched, resampled, reshaped or synthesised. There is no generative step.
 * - A protection band around the product keeps source pixels, so edges are
 *   never eroded or morphed; feathering only ever edits background pixels.
 * - After compositing, every product pixel is compared with the source; any
 *   difference aborts and returns the original buffer.
 * - Cluttered scenes (table/room/hand/box touching the frame edge) cannot be
 *   segmented safely without a model, so they are left untouched
 *   (reason "cluttered_background") instead of risking product damage.
 * - Only exterior backdrop is repainted: backdrop-coloured pixels inside the
 *   product's row AND column span are kept as source (covers white labels on
 *   white walls, gaps between items) — ambiguity always resolves to "keep".
 * - Light/white backdrops are skipped (nothing to gain, only risk), and
 *   non-convex masks (solidity < 0.85, the signature of a flood leaking into a
 *   backdrop-coloured product part) abort the whole operation. If more than
 *   1% of the product's interior matches the backdrop colour (grey sole on a
 *   grey floor) the operation is also aborted.
 * - Implausible masks (product < 3% or > 97% of the frame) are rejected.
 */
export async function cleanBackground(buffer) {
  const sharpModule = (await import("sharp")).default;
  const none = (reason, extra = {}) => ({ buffer, applied: false, reason, ...extra });
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 128) return none("empty_or_corrupt_buffer");

  let data;
  let w;
  let h;
  try {
    const decoded = await sharpModule(buffer)
      .rotate()
      .flatten({ background: "#ffffff" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = decoded.data;
    w = decoded.info.width;
    h = decoded.info.height;
    if (decoded.info.channels !== 3) return none("unsupported_channels");
  } catch {
    return none("unreadable_image");
  }
  if (!w || !h || w < 16 || h < 16) return none("too_small");
  if (Math.max(w, h) > BG_MAX_SIDE) return none("too_large_for_safe_processing");

  const n = w * h;
  const dist = (a, r, g, b) => {
    const dr = data[a] - r;
    const dg = data[a + 1] - g;
    const db = data[a + 2] - b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  // 1. Backdrop colour = per-channel median of a 2px border ring.
  const border = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) border.push(y * w + x);
    }
  }
  const median = (c) => {
    const vals = border.map((p) => data[p * 3 + c]).sort((a, b) => a - b);
    return vals[vals.length >> 1];
  };
  const bgR = median(0);
  const bgG = median(1);
  const bgB = median(2);

  // 2. The border must agree with the backdrop, otherwise the frame edge
  //    contains clutter or the product itself → unsafe, leave untouched.
  let agree = 0;
  for (const p of border) if (dist(p * 3, bgR, bgG, bgB) <= BG_GLOBAL_TOLERANCE) agree += 1;
  const borderAgreement = agree / border.length;
  if (borderAgreement < BG_BORDER_AGREEMENT) return none("cluttered_background", { borderAgreement });
  // Light/white backdrops: already presentable, and white labels/soles/dials
  // touching them are indistinguishable by colour → never risk repainting.
  if (Math.min(bgR, bgG, bgB) >= BG_LIGHT_BACKDROP) return none("light_backdrop_already_clean", { borderAgreement });

  // 3. Edge-seeded, gradient-limited flood fill over backdrop-coloured pixels.
  const bg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (const p of border) {
    if (!bg[p] && dist(p * 3, bgR, bgG, bgB) <= BG_GLOBAL_TOLERANCE) {
      bg[p] = 1;
      queue[tail++] = p;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    const pr = data[p * 3];
    const pg = data[p * 3 + 1];
    const pb = data[p * 3 + 2];
    const visit = (q) => {
      if (bg[q]) return;
      const qa = q * 3;
      if (dist(qa, pr, pg, pb) > BG_STEP_TOLERANCE) return;
      if (dist(qa, bgR, bgG, bgB) > BG_GLOBAL_TOLERANCE) return;
      bg[q] = 1;
      queue[tail++] = q;
    };
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (y > 0) visit(p - w);
    if (y < h - 1) visit(p + w);
  }

  // 3b. Only EXTERIOR backdrop may be repainted. Backdrop-coloured pixels that
  //     lie inside both the product's row span and column span (e.g. a white
  //     label touching a white wall, gaps between a pair of shoes) are
  //     ambiguous, so they are protected and keep their exact source bytes.
  const rowMin = new Int32Array(h).fill(w);
  const rowMax = new Int32Array(h).fill(-1);
  const colMin = new Int32Array(w).fill(h);
  const colMax = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (bg[y * w + x]) continue;
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
      if (y < colMin[x]) colMin[x] = y;
      if (y > colMax[x]) colMax[x] = y;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (bg[i] && x >= rowMin[y] && x <= rowMax[y] && y >= colMin[x] && y <= colMax[x]) bg[i] = 0;
    }
  }

  let bgCount = 0;
  for (let i = 0; i < n; i += 1) bgCount += bg[i];
  const productFraction = 1 - bgCount / n;
  if (productFraction < 0.03) return none("no_distinct_product", { productFraction, borderAgreement });
  if (productFraction > 0.97) return none("nothing_to_clean", { productFraction, borderAgreement });

  // 3c. Leak guard: a flood that crept into a backdrop-coloured product part
  //     carves a notch into the silhouette. Require a near-convex mask
  //     (solidity >= BG_MIN_SOLIDITY) or abort without touching anything.
  const pts = [];
  for (let y = 0; y < h; y += 1) {
    if (rowMax[y] < 0) continue;
    pts.push([rowMin[y], y], [rowMax[y] + 1, y], [rowMin[y], y + 1], [rowMax[y] + 1, y + 1]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const pt of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper = [];
  for (let k = pts.length - 1; k >= 0; k -= 1) {
    const pt = pts[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let hullArea = 0;
  for (let k = 0; k < hull.length; k += 1) {
    const a = hull[k];
    const b = hull[(k + 1) % hull.length];
    hullArea += a[0] * b[1] - b[0] * a[1];
  }
  hullArea = Math.abs(hullArea) / 2;
  const solidity = hullArea > 0 ? (n - bgCount) / hullArea : 0;
  if (solidity < BG_MIN_SOLIDITY) return none("irregular_mask_unsafe", { productFraction, borderAgreement, solidity });

  // 4. Distance (in px, chessboard) from each background pixel to the product,
  //    capped at protect+feather+1, via multi-source BFS from product pixels.
  const cap = BG_PROTECT_PX + BG_FEATHER_PX + 1;
  const near = new Uint8Array(n).fill(cap);
  head = 0;
  tail = 0;
  for (let i = 0; i < n; i += 1) {
    if (!bg[i]) {
      near[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const d = near[p] + 1;
    if (d >= cap) continue;
    const x = p % w;
    const y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy += 1) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const q = yy * w + xx;
        if (near[q] > d) {
          near[q] = d;
          queue[tail++] = q;
        }
      }
    }
  }

  // 4b. Colour-evidence guard: if the product itself contains backdrop-coloured
  //     areas (ignoring its anti-aliased rim), some of them may touch the
  //     backdrop and have been flooded. Ambiguous → abort, leave untouched.
  let interior = 0;
  let backdropLike = 0;
  for (let i = 0; i < n; i += 1) {
    if (bg[i] || near[i] !== 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    let rim = false;
    for (let dy = -BG_PROTECT_PX; dy <= BG_PROTECT_PX && !rim; dy += 1) {
      for (let dx = -BG_PROTECT_PX; dx <= BG_PROTECT_PX; dx += 1) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && bg[yy * w + xx]) { rim = true; break; }
      }
    }
    if (rim) continue;
    interior += 1;
    if (dist(i * 3, bgR, bgG, bgB) <= BG_GLOBAL_TOLERANCE) backdropLike += 1;
  }
  const backdropLikeShare = interior ? backdropLike / interior : 1;
  if (backdropLikeShare > BG_MAX_BACKDROP_LIKE_PRODUCT) {
    return none("product_resembles_backdrop", { productFraction, borderAgreement, solidity, backdropLikeShare });
  }

  // 5. Composite: product + protection band = source bytes; background → white.
  const out = Buffer.from(data);
  for (let i = 0; i < n; i += 1) {
    if (!bg[i]) continue;
    const d = near[i];
    if (d <= BG_PROTECT_PX) continue;
    const t = Math.min(1, (d - BG_PROTECT_PX) / (BG_FEATHER_PX + 1));
    const a = i * 3;
    out[a] = Math.round(data[a] + (255 - data[a]) * t);
    out[a + 1] = Math.round(data[a + 1] + (255 - data[a + 1]) * t);
    out[a + 2] = Math.round(data[a + 2] + (255 - data[a + 2]) * t);
  }

  // 6. Invariant: not a single product pixel may differ from the source.
  for (let i = 0; i < n; i += 1) {
    if (bg[i]) continue;
    const a = i * 3;
    if (out[a] !== data[a] || out[a + 1] !== data[a + 1] || out[a + 2] !== data[a + 2]) {
      return none("product_pixel_invariant_failed");
    }
  }

  const png = await sharpModule(out, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  return {
    buffer: png,
    applied: true,
    reason: null,
    productFraction,
    borderAgreement,
    solidity,
    backgroundColor: [bgR, bgG, bgB],
    mask: bg,
    width: w,
    height: h,
  };
}

/* ------------------------------------------------------------------ */
/* Safe deterministic cleanup & optimisation to WebP ≤ 200 KB           */
/* Preserves exact product shape, proportions, colour, and details.     */
/* ------------------------------------------------------------------ */
export async function optimiseImage(buffer, { minQuality = 46, maxWidth = 1200, trimBorders = true, removeBackground = true } = {}) {
  const sharpModule = (await import("sharp")).default;
  let sourceBuffer = buffer;

  // True background cleanup (product pixels untouched, see cleanBackground).
  if (removeBackground) {
    try {
      const cleaned = await cleanBackground(buffer);
      if (cleaned.applied) sourceBuffer = cleaned.buffer;
    } catch {
      sourceBuffer = buffer;
    }
  }

  // Safe border whitespace/letterbox trim: ONLY keep the trim if it preserves
  // at least 75% of both width and height, guaranteeing we never crop into the product.
  if (trimBorders) {
    try {
      const meta = await sharpModule(sourceBuffer).rotate().metadata();
      if (meta.width && meta.height && typeof sharpModule(sourceBuffer).trim === "function") {
        const trimmed = await sharpModule(sourceBuffer)
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
      /* keep the (possibly background-cleaned) source untouched */
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
  await resolveFfmpeg();
  if (!ffmpegPath) throw new Error("ffmpeg unavailable (install ffmpeg-static in worker)");
  fs.mkdirSync(TMP, { recursive: true });

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
    // ffmpeg-static ships no ffprobe binary: read "Duration: HH:MM:SS.xx" from
    // `ffmpeg -i` instead, so frames are sampled across the WHOLE video rather
    // than only its first 3 seconds (often a blank/intro segment).
    try {
      await run(ffmpegPath, ["-hide_banner", "-i", input], { timeout: WORKERTIMEOUT });
    } catch (err) {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(err?.stderr || ""));
      if (m) durationSec = Math.max(0.5, Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    }
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
  cleanBackground,
  processVideo,
  processImages,
  sharpness,
  assessImageQuality,
  framesForCategory,
  getPublicUrl,
  toPublicUrl,
};

export default mediaEngine;
