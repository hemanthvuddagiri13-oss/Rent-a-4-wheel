import { prisma } from "@/lib/prisma";
import { visibleJurisdictions } from "@/lib/jurisdiction";
import type { Prisma } from "@prisma/client";
import { getAvailableVehicleIds } from "@/lib/availability";
import type { VehicleCardData } from "@/components/vehicles/vehicle-card";

const publicInventory: Prisma.VehicleWhereInput = { status: "ACTIVE", isDemo: false, listingApproval: "APPROVED", OR: [{ hostId: null }, { host: { onboardingStatus: "APPROVED" } }] };

type VehicleWithImages = {
  id: string;
  slug: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  category: string;
  seats: number;
  transmission: string;
  fuelType: string;
  mileageAllowancePerDay: number;
  dailyRateCents: number;
  weeklyRateCents: number;
  monthlyRateCents: number;
  images: { url: string; isPrimary: boolean }[];
};

export function toVehicleCardData(vehicle: VehicleWithImages): VehicleCardData {
  const primary = vehicle.images.find((i) => i.isPrimary) ?? vehicle.images[0];
  return {
    id: vehicle.id,
    slug: vehicle.slug,
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.model,
    trim: vehicle.trim,
    category: vehicle.category,
    seats: vehicle.seats,
    transmission: vehicle.transmission,
    fuelType: vehicle.fuelType,
    mileageAllowancePerDay: vehicle.mileageAllowancePerDay,
    dailyRateCents: vehicle.dailyRateCents,
    weeklyRateCents: vehicle.weeklyRateCents,
    monthlyRateCents: vehicle.monthlyRateCents,
    imageUrl: primary?.url ?? null,
  };
}

const cardSelect = {
  id: true,
  slug: true,
  year: true,
  make: true,
  model: true,
  trim: true,
  category: true,
  seats: true,
  transmission: true,
  fuelType: true,
  mileageAllowancePerDay: true,
  dailyRateCents: true,
  weeklyRateCents: true,
  monthlyRateCents: true,
  images: { select: { url: true, isPrimary: true }, orderBy: { position: "asc" as const } },
};

export async function getFeaturedVehicles(limit = 9): Promise<VehicleCardData[]> {
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: { ...publicInventory, jurisdictionCode: { in: await visibleJurisdictions() } },
      select: cardSelect,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return vehicles.map(toVehicleCardData);
  } catch {
    return [];
  }
}

export interface VehicleSearchFilters {
  location?: string;
  pickupAt?: Date;
  returnAt?: Date;
  category?: string;
  priceMin?: number;
  priceMax?: number;
  seats?: number;
  make?: string;
  transmission?: string;
  sort?: "price_asc" | "price_desc" | "newest" | "recommended";
}

export async function searchVehicles(filters: VehicleSearchFilters): Promise<VehicleCardData[]> {
  try {
    const where: Prisma.VehicleWhereInput = { ...publicInventory, jurisdictionCode: { in: await visibleJurisdictions() } };

    if (filters.location) where.location = { contains: filters.location, mode: "insensitive" };
    if (filters.category && filters.category !== "ALL") {
      where.category = filters.category as Prisma.EnumVehicleCategoryFilter["equals"];
    }
    if (filters.seats) where.seats = { gte: filters.seats };
    if (filters.make) where.make = { equals: filters.make, mode: "insensitive" };
    if (filters.transmission) where.transmission = filters.transmission as Prisma.EnumTransmissionFilter["equals"];
    if (filters.priceMin != null || filters.priceMax != null) {
      where.dailyRateCents = {
        ...(filters.priceMin != null ? { gte: filters.priceMin * 100 } : {}),
        ...(filters.priceMax != null ? { lte: filters.priceMax * 100 } : {}),
      };
    }

    if (filters.pickupAt && filters.returnAt) {
      const availableIds = await getAvailableVehicleIds(filters.pickupAt, filters.returnAt);
      where.id = { in: availableIds };
    }

    const orderBy: Prisma.VehicleOrderByWithRelationInput =
      filters.sort === "price_asc"
        ? { dailyRateCents: "asc" }
        : filters.sort === "price_desc"
        ? { dailyRateCents: "desc" }
        : filters.sort === "newest"
        ? { year: "desc" }
        : { createdAt: "desc" }; // recommended (default)

    const vehicles = await prisma.vehicle.findMany({ where, select: cardSelect, orderBy });
    return vehicles.map(toVehicleCardData);
  } catch {
    return [];
  }
}

export async function getVehicleBySlug(slug: string) {
  return prisma.vehicle.findFirst({
    where: { ...publicInventory, slug, jurisdictionCode: { in: await visibleJurisdictions() } },
    include: {
      images: { orderBy: { position: "asc" } },
      features: { include: { feature: true } },
    },
  });
}

export async function getDistinctMakes(): Promise<string[]> {
  try {
    const rows = await prisma.vehicle.findMany({
      where: { ...publicInventory, jurisdictionCode: { in: await visibleJurisdictions() } },
      select: { make: true },
      distinct: ["make"],
      orderBy: { make: "asc" },
    });
    return rows.map((r) => r.make);
  } catch {
    return [];
  }
}

/** Suggestions reflect only inventory currently visible under jurisdiction authority. */
export async function getDistinctLocations(): Promise<string[]> {
  try {
    const rows = await prisma.vehicle.findMany({
      where: { ...publicInventory, jurisdictionCode: { in: await visibleJurisdictions() } },
      select: { location: true }, distinct: ["location"], orderBy: { location: "asc" },
    });
    return rows.map(row => row.location).filter(Boolean);
  } catch { return []; }
}
