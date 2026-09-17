import { afterAll, describe, expect, it, vi } from "vitest";
import { barrier } from "./helpers/barrier";
import { prisma, createTestCustomer } from "./helpers/factories";
import { prisma as workerDb } from "@/lib/prisma";
const email = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({ sendEmail: email }));
const { processOutboxOnce } = await import("@/lib/outbox");
const users: string[] = [], messages: string[] = [];
afterAll(async () => {
  await prisma.outboxMessage.deleteMany({ where: { id: { in: messages } } });
  await prisma.notification.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});
async function fixture() {
  const u = await createTestCustomer(); users.push(u.id);
  const message = await prisma.outboxMessage.create({ data: { type: "notification", payload: { userId: u.id, type: "PAYMENT_RECEIPT", extra: { amountCents: 1000 } } } });
  messages.push(message.id); return message;
}
describe("outbox execution", () => {
  it("rejects a stale candidate after another worker fails delivery", async () => {
    const message = await fixture(), entered = barrier(), release = barrier();
    email.mockReset().mockResolvedValue({ sent: false, error: "unknown provider outcome" });
    const update = workerDb.outboxMessage.updateMany.bind(workerDb.outboxMessage);
    const delayed = async (args: Parameters<typeof update>[0]) => {
      entered.release(); await release.wait; return update(args);
    };
    // The caller awaits the result; the test barrier replaces Prisma's lazy promise.
    const spy = vi.spyOn(workerDb.outboxMessage, "updateMany").mockImplementationOnce(delayed as unknown as typeof update);
    const stale = processOutboxOnce(1, [message.id]);
    await entered.wait;
    try {
      expect((await processOutboxOnce(1, [message.id])).failed).toBe(1);
    } finally { release.release(); }
    try {
      expect(await stale).toEqual({ processed: 0, failed: 0 });
      expect(email).toHaveBeenCalledOnce();
      expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } })).attempts).toBe(1);
    } finally { spy.mockRestore(); }
  });
  it("exclusively claims delivery while another dispatcher is still sending", async () => {
    const message = await fixture(), entered = barrier(), release = barrier();
    email.mockReset().mockImplementation(async () => { entered.release(); await release.wait; return { sent: true }; });
    const first = processOutboxOnce(1, [message.id]);
    await entered.wait;
    const second = await processOutboxOnce(1, [message.id]);
    expect(second.processed).toBe(0);
    release.release(); await first;
    expect(email).toHaveBeenCalledOnce();
    expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } })).status).toBe("SENT");
  });
  it("does not acknowledge failed delivery and reuses the immutable snapshot and provider key", async () => {
    const message = await fixture();
    email.mockReset().mockResolvedValueOnce({ sent: false, error: "network timeout" }).mockResolvedValueOnce({ sent: true });
    expect((await processOutboxOnce(1, [message.id])).failed).toBe(1);
    expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } })).status).toBe("PENDING");
    await prisma.outboxMessage.update({ where: { id: message.id }, data: { nextRetryAt: new Date(0) } });
    await processOutboxOnce(1, [message.id]);
    expect(email.mock.calls[1][0]).toEqual(email.mock.calls[0][0]);
    expect(email.mock.calls[0][0].idempotencyKey).toBe(message.id);
    expect(await prisma.notification.count({ where: { deliveryKey: message.id } })).toBe(1);
  });
});

it("replacement outbox success fences the old worker's later failure on both projections",async()=>{
 const message=await fixture(),entered=barrier(),release=barrier();
 email.mockReset().mockImplementationOnce(async()=>{entered.release();await release.wait;throw new Error("late transport failure")}).mockResolvedValueOnce({sent:true});
 const stale=processOutboxOnce(1,[message.id]);await entered.wait;
 await prisma.outboxMessage.update({where:{id:message.id},data:{leaseExpiresAt:new Date(0)}});
 try {expect((await processOutboxOnce(1,[message.id])).processed).toBe(1)} finally {release.release()}
 await stale;
 expect((await prisma.outboxMessage.findUniqueOrThrow({where:{id:message.id}})).status).toBe("SENT");
 expect((await prisma.notification.findUniqueOrThrow({where:{deliveryKey:message.id}})).status).toBe("SENT");
});
