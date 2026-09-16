"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, Star } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ReviewData {
  id: string;
  authorName: string;
  rating: number;
  comment: string;
}

export function ReviewsCarousel({ reviews }: { reviews: ReviewData[] }) {
  const [index, setIndex] = useState(0);
  if (reviews.length === 0) return null;
  const review = reviews[index];

  return (
    <div className="mx-auto max-w-2xl text-center">
      <div className="rounded-2xl border border-white/10 bg-card p-8 sm:p-10">
        <div className="flex justify-center gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star
              key={i}
              className={cn("h-5 w-5", i < review.rating ? "fill-gold text-gold" : "text-white/15")}
            />
          ))}
        </div>
        <p className="mt-5 text-lg leading-relaxed text-silver">&ldquo;{review.comment}&rdquo;</p>
        <p className="mt-5 font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">
          {review.authorName}
        </p>
      </div>

      {reviews.length > 1 && (
        <div className="mt-6 flex items-center justify-center gap-4">
          <button
            aria-label="Previous review"
            onClick={() => setIndex((i) => (i - 1 + reviews.length) % reviews.length)}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 text-muted hover:border-gold hover:text-gold"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex gap-1.5">
            {reviews.map((r, i) => (
              <button
                key={r.id}
                aria-label={`Go to review ${i + 1}`}
                onClick={() => setIndex(i)}
                className={cn("h-1.5 w-1.5 rounded-full transition-all", i === index ? "w-5 bg-gold" : "bg-white/20")}
              />
            ))}
          </div>
          <button
            aria-label="Next review"
            onClick={() => setIndex((i) => (i + 1) % reviews.length)}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 text-muted hover:border-gold hover:text-gold"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
