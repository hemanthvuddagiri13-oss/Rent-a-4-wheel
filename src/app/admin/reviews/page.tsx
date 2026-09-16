import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ReviewToggle } from "@/components/admin/review-toggle";
import { createReview } from "@/app/admin/reviews/actions";

export const metadata: Metadata = { title: "Reviews", robots: { index: false } };
export const revalidate = 0;

export default async function AdminReviewsPage() {
  const reviews = await prisma.review.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-3xl font-bold text-white">Customer Reviews</h1>
      <p className="mt-1 text-sm text-muted">
        Only published reviews appear on the homepage. Add real customer feedback here — never fabricated reviews.
      </p>

      <form action={createReview} className="mt-6 space-y-3 rounded-xl border border-white/10 bg-card p-5">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-gold-bright">Add Review</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="authorName">Customer Name</Label>
            <Input id="authorName" name="authorName" required className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="rating">Rating (1-5)</Label>
            <Input id="rating" name="rating" type="number" min={1} max={5} required className="mt-1.5" />
          </div>
        </div>
        <div>
          <Label htmlFor="comment">Comment</Label>
          <Textarea id="comment" name="comment" required className="mt-1.5" rows={3} />
        </div>
        <div className="flex items-center gap-2">
          <input id="isPublished" name="isPublished" type="checkbox" className="h-4 w-4 rounded border-white/25 bg-card accent-gold" />
          <Label htmlFor="isPublished">Publish immediately</Label>
        </div>
        <Button type="submit">Add Review</Button>
      </form>

      <div className="mt-8 space-y-3">
        {reviews.map((r) => (
          <div key={r.id} className="flex items-start justify-between gap-4 rounded-xl border border-white/10 bg-card p-4">
            <div>
              <p className="font-medium text-white">
                {r.authorName} &middot; {r.rating}★{r.isDemo && <Badge variant="secondary" className="ml-2">Sample</Badge>}
              </p>
              <p className="mt-1 text-sm text-muted">{r.comment}</p>
            </div>
            <ReviewToggle reviewId={r.id} isPublished={r.isPublished} />
          </div>
        ))}
      </div>
    </div>
  );
}
