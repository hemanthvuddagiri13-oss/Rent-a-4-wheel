import { afterAll, describe, expect, it, vi } from "vitest";
import { barrier } from "./helpers/barrier";
import { prisma, createTestCustomer } from "./helpers/factories";
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
