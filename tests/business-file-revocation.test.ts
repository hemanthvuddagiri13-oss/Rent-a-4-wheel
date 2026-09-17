import { afterAll, beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma, createTestHost, createTestCustomer, createTestVehicle } from "./helpers/factories";
const mocks = vi.hoisted(() => {
  const old = Object.fromEntries(["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"].map(k => [k, process.env[k]]));
  for (const key of Object.keys(old)) process.env[key] = "synthetic-file-test";
  return { old, session: null as { user: { id: string; role: string } } | null, signedUrl: vi.fn(() => "https://synthetic.invalid/private"), read: vi.fn(), stored: vi.fn(async () => ({ storageKey: "cloudinary:private-business-evidence" })) };
});
vi.mock("@/auth", () => ({ auth: async () => mocks.session }));
vi.mock("cloudinary", () => ({ v2: { config: vi.fn(), utils: { private_download_url: mocks.signedUrl } } }));
vi.mock("@/lib/storage", async original => {
  const real = await original<typeof import("@/lib/storage")>();
  return { ...real, storePrivateDocument: mocks.stored, readPrivateDocument: async (key: string) => { mocks.read(key); return real.readPrivateDocument(key); } };
});
vi.mock("@/lib/documents", async original => ({ ...await original<typeof import("@/lib/documents")>(), scanForMalware: async () => ({ status: "CLEAN" }) }));
const { POST } = await import("@/app/api/host/files/route");
const { GET } = await import("@/app/api/marketplace/files/[id]/route");
const { GET: agreementGET } = await import("@/app/api/host/vehicles/[id]/agreement/route");
const users: string[] = [], hosts: string[] = [], vehicles: string[] = [];
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn(async () => new Response("private bytes"))); });
afterAll(async () => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(mocks.old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
  await prisma.marketplaceFile.deleteMany({ where: { hostId: { in: hosts } } });
  await prisma.agreementAcceptance.deleteMany({ where: { vehicleId: { in: vehicles } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicles } } });
  await prisma.hostProfile.deleteMany({ where: { id: { in: hosts } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});
const read = (id: string) => GET(new Request("http://localhost/api/marketplace/files/" + id), { params: Promise.resolve({ id }) });
async function denied(id: string) {
  mocks.read.mockClear(); mocks.signedUrl.mockClear();
  const response = await read(id);
  expect(response.status).toBe(404); expect(await response.text()).toBe("Not found");
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.signedUrl).not.toHaveBeenCalled();
}
it.each(["REGISTRATION", "INSURANCE", "OWNERSHIP"])("rechecks real membership on every %s GET, including the former uploader", async purpose => {
  const owner = await createTestHost(), other = await createTestHost(), manager = await createTestCustomer({ role: "HOST_EMPLOYEE" }), staff = await createTestCustomer({ role: "HOST_EMPLOYEE" }), admin = await createTestCustomer({ role: "ADMIN" });
  users.push(owner.user.id, other.user.id, manager.id, staff.id, admin.id); hosts.push(owner.hostProfile.id, other.hostProfile.id);
  const vehicle = await createTestVehicle({ hostId: owner.hostProfile.id }); vehicles.push(vehicle.id);
  await prisma.hostEmployee.createMany({ data: [{ hostId: owner.hostProfile.id, userId: manager.id, role: "MANAGER" }, { hostId: owner.hostProfile.id, userId: staff.id, role: "STAFF" }] });
  const session = { user: { id: manager.id, role: manager.role } }; mocks.session = session;
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: "silver" } }).png().toBuffer();
  const form = new FormData(); form.set("vehicleId", vehicle.id); form.set("purpose", purpose); form.set("file", new File([new Uint8Array(image)], "test.png", { type: "image/png" }));
  const upload = await POST(new Request("http://localhost/api/host/files", { method: "POST", body: form }));
  expect(upload.status, await upload.clone().text()).toBe(200); const { id } = await upload.json();
  expect((await read(id)).status).toBe(200); expect(mocks.read).toHaveBeenCalledTimes(1); expect(mocks.signedUrl).toHaveBeenCalledTimes(1);
  expect(await prisma.auditLog.count({ where: { actorId: manager.id, entityId: id, action: "host.file.read" } })).toBe(1);
  await prisma.hostEmployee.delete({ where: { hostId_userId: { hostId: owner.hostProfile.id, userId: manager.id } } });
  expect(mocks.session).toBe(session); await denied(id); await denied("unknown-file-id");
  mocks.session = { user: owner.user }; expect((await read(id)).status).toBe(200);
  mocks.session = { user: staff }; await denied(id);
  mocks.session = { user: other.user }; await denied(id);
  mocks.session = session;
  await prisma.hostEmployee.create({ data: { hostId: owner.hostProfile.id, userId: manager.id, role: "STAFF" } }); await denied(id);
  await prisma.hostEmployee.update({ where: { hostId_userId: { hostId: owner.hostProfile.id, userId: manager.id } }, data: { role: "MANAGER" } });
  expect((await read(id)).status).toBe(200);
  await prisma.hostEmployee.update({ where: { hostId_userId: { hostId: owner.hostProfile.id, userId: manager.id } }, data: { isActive: false } }); await denied(id);
  await prisma.hostEmployee.update({ where: { hostId_userId: { hostId: owner.hostProfile.id, userId: manager.id } }, data: { isActive: true, expiresAt: new Date(0) } }); await denied(id);
  await prisma.hostEmployee.update({ where: { hostId_userId: { hostId: owner.hostProfile.id, userId: manager.id } }, data: { expiresAt: new Date(Date.now() + 3600000) } }); expect((await read(id)).status).toBe(200);
  await prisma.user.update({ where: { id: manager.id }, data: { isActive: false } }); await denied(id);
  await prisma.user.update({ where: { id: manager.id }, data: { isActive: true, role: "CUSTOMER" } }); await denied(id);
  await prisma.user.update({ where: { id: manager.id }, data: { role: "HOST_EMPLOYEE" } });
  await prisma.hostProfile.update({ where: { id: owner.hostProfile.id }, data: { onboardingStatus: "SUSPENDED" } }); await denied(id);
  await prisma.hostProfile.update({ where: { id: owner.hostProfile.id }, data: { onboardingStatus: "APPROVED" } }); expect((await read(id)).status).toBe(200);
  mocks.session = { user: admin }; expect((await read(id)).status).toBe(200);
  await prisma.user.update({ where: { id: admin.id }, data: { isActive: false } }); await denied(id);
  // The second private-business download route shares the same policy.
  const acceptance = await prisma.agreementAcceptance.create({ data: { type: "HOST_AGREEMENT", vehicleId: vehicle.id, signedByUserId: owner.user.id, signerName: "Synthetic owner", contentSnapshot: "Synthetic", contentHash: "test", documentVersion: "test", signedPdfStorageKey: "cloudinary:private-agreement" } });
  const request = new Request(`http://localhost/api/host/vehicles/${vehicle.id}/agreement?acceptanceId=${acceptance.id}`);
  mocks.session = { user: staff }; mocks.read.mockClear(); mocks.signedUrl.mockClear();
  expect((await agreementGET(request, { params: Promise.resolve({ id: vehicle.id }) })).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.signedUrl).not.toHaveBeenCalled();
  mocks.session = { user: owner.user }; expect((await agreementGET(request, { params: Promise.resolve({ id: vehicle.id }) })).status).toBe(200);
});
