"use client";

import { useState } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

export function Gallery({ images, alt }: { images: string[]; alt: string }) {
  const [active, setActive] = useState(0);
  const list = images.length > 0 ? images : ["/images/vehicles/sedan.svg"];

  return (
    <div>
      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-xl border border-white/10 bg-surface">
        <Image src={list[active]} alt={alt} fill priority className="object-cover" sizes="(min-width: 1024px) 55vw, 100vw" />
      </div>
      {list.length > 1 && (
        <div className="mt-3 flex gap-2 overflow-x-auto scrollbar-thin">
          {list.map((src, i) => (
            <button
              key={src + i}
              onClick={() => setActive(i)}
              className={cn(
                "relative h-16 w-24 shrink-0 overflow-hidden rounded-md border transition-all",
                i === active ? "border-gold" : "border-white/10 opacity-70 hover:opacity-100"
              )}
              aria-label={`View image ${i + 1}`}
            >
              <Image src={src} alt="" fill className="object-cover" sizes="96px" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
