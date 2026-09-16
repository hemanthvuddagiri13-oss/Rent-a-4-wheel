import { prisma } from "@/lib/prisma";
import type { ReviewData } from "@/components/home/reviews-carousel";

export async function getPublishedReviews(limit = 10): Promise<ReviewData[]> {
  try {
    const reviews = await prisma.review.findMany({
      where: { isPublished: true },
      select: { id: true, authorName: true, rating: true, comment: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return reviews;
  } catch {
    return [];
  }
}
