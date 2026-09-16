import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { SITE_URL } from "@/lib/constants";

const STATIC_ROUTES = [
  "",
  "/vehicles",
  "/how-it-works",
  "/long-term-rentals",
  "/faq",
  "/contact",
  "/legal/terms-and-conditions",
  "/legal/privacy-policy",
  "/legal/cancellation-policy",
  "/legal/insurance-policy",
  "/legal/damage-policy",
  "/legal/security-deposit-policy",
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified: new Date(),
    changeFrequency: path === "" ? "daily" : "weekly",
    priority: path === "" ? 1 : 0.7,
  }));

  let vehicleEntries: MetadataRoute.Sitemap = [];
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: { status: "ACTIVE" },
      select: { slug: true, updatedAt: true },
    });
    vehicleEntries = vehicles.map((v) => ({
      url: `${SITE_URL}/vehicles/${v.slug}`,
      lastModified: v.updatedAt,
      changeFrequency: "weekly",
      priority: 0.8,
    }));
  } catch {
    // DB unavailable at build time — ship static routes only.
  }

  return [...staticEntries, ...vehicleEntries];
}
