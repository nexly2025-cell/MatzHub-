"use client";

import Image from "next/image";
import { useState } from "react";

/**
 * Product gallery: photo mode + video mode.
 *
 * Photo: images[0] is the cover, gallery below, hover-zoom lens.
 * Video (footwear/watches): mp4 plays inline first, generated frames below.
 */
export default function ProductGallery({
  images,
  heroImage,
  alt,
  priority = false,
  mediaType = "image",
  videoUrl = null,
}: {
  images: string[];
  heroImage: string;
  alt: string;
  priority?: boolean;
  mediaType?: "image" | "video";
  videoUrl?: string | null;
}) {
  const all = [heroImage, ...images.filter((i) => i && i !== heroImage)].slice(0, 6);
  const hasVideo = mediaType === "video" && Boolean(videoUrl);
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [lens, setLens] = useState({ x: 50, y: 50 });
  const [showVideo, setShowVideo] = useState(hasVideo);
  const current = all[active] ?? all[0];

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setLens({
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    });
  };

  return (
    <div>
      <div className="relative aspect-square overflow-hidden rounded-2xl border border-line bg-surface-3">
        {showVideo && videoUrl ? (
          <>
            <video
              src={videoUrl}
              poster={heroImage}
              controls
              playsInline
              preload="metadata"
              className="h-full w-full object-cover"
              aria-label={alt}
            />
            <button
              type="button"
              onClick={() => setShowVideo(false)}
              className="absolute bottom-3 left-3 z-10 rounded bg-black/70 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur"
            >
              Photos
            </button>
          </>
        ) : (
          <div
            className="group relative h-full w-full cursor-zoom-in"
            onMouseEnter={() => setZoom(true)}
            onMouseLeave={() => setZoom(false)}
            onMouseMove={onMove}
            role="img"
            aria-label={alt}
          >
            <Image
              src={current}
              alt={alt}
              fill
              priority={priority}
              sizes="(max-width: 1024px) 100vw, 700px"
              className={`object-cover transition-transform duration-500 ${zoom ? "scale-[1.9]" : ""}`}
              style={zoom ? { transformOrigin: `${lens.x}% ${lens.y}%` } : undefined}
            />
            {all.length > 1 && (
              <span className="absolute bottom-3 right-3 rounded-full bg-black/60 px-2.5 py-1 text-[10px] backdrop-blur">
                {active + 1} / {all.length}
              </span>
            )}
            <span className="pointer-events-none absolute left-3 top-3 hidden rounded-full bg-black/60 px-2.5 py-1 text-[10px] text-white/70 backdrop-blur group-hover:block">
              Hover to zoom
            </span>
          </div>
        )}
        {hasVideo && !showVideo && (
          <button
            type="button"
            onClick={() => setShowVideo(true)}
            className="absolute bottom-3 left-3 z-10 rounded bg-black/70 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur"
          >
            ▶ Play video
          </button>
        )}
      </div>

      {all.length > 1 && (
        <div className="mt-3 flex gap-2 overflow-x-auto no-scrollbar pb-1" role="tablist" aria-label="Product images">
          {all.map((src, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={active === i && !showVideo}
              aria-label={hasVideo && i === 0 ? `Frame ${i + 1}` : `Image ${i + 1}`}
              onClick={() => {
                setActive(i);
                if (hasVideo) setShowVideo(false);
              }}
              className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition-all ${
                active === i && !showVideo ? "border-[#c9a227]" : "border-transparent opacity-60 hover:opacity-100"
              }`}
            >
              <Image src={src} alt="" fill sizes="64px" className="object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
