import { afterAll, expect, it } from "vitest";
import { prisma, createTestVehicle } from "./helpers/factories";
import { getDistinctLocations } from "@/lib/data/vehicles";

afterAll(() => prisma.$disconnect());

it("location suggestions use the same visible inventory and jurisdiction authority as discovery", async () => {
  const prefix = "phase6-" + crypto.randomUUID();
  try {
    const active = await createTestVehicle({ location: prefix + "-visible" });
    const inactive = await createTestVehicle({ location: prefix + "-inactive", status: "INACTIVE" });
    const pending = await createTestVehicle({ location: prefix + "-pending", listingApproval: "PENDING" });
    // Seeded states remain disabled unless explicitly configured for staging.
    expect((await prisma.jurisdiction.findUniqueOrThrow({ where: { code: "CA" } })).mode).toBe("DISABLED");
    const disabled = await createTestVehicle({ location: prefix + "-disabled", jurisdictionCode: "CA" });
    const suggestions = await getDistinctLocations();
    expect(suggestions).toContain(active.location);
    expect(suggestions).not.toContain(inactive.location);
    expect(suggestions).not.toContain(pending.location);
    expect(suggestions).not.toContain(disabled.location);
  } finally {
    await prisma.vehicle.updateMany({ where: { location: { startsWith: prefix } }, data: { status: "INACTIVE" } });
  }
});
