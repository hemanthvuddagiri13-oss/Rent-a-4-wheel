import type { Prisma } from "@prisma/client";
export async function quarantineOperation(tx: Prisma.TransactionClient, id: string, reason: string) {
  const op = await tx.financialOperation.findUniqueOrThrow({ where: { id } });
  if (!op.reservationId) return;
  const r = await tx.reservation.findUniqueOrThrow({ where: { id: op.reservationId } });
  const payload = op.payload as { amount?: number; currency?: string; intentId?: string };
  const target = op.kind === "DEPOSIT_RELEASE" ? payload.intentId : op.providerId;
  const original = op.kind === "DEPOSIT_RELEASE" && target ? await tx.financialOperation.findFirst({ where: { reservationId: r.id, kind: "DEPOSIT", providerId: target } }) : op;
  const terms = original?.payload as { amount?: number; currency?: string } | undefined;
  const deposit = target ? await tx.securityDeposit.findFirst({ where: { reservationId: r.id, stripePaymentIntentId: target } }) : null;
  const payment = op.kind === "RENTAL" ? await tx.payment.findFirst({ where: { reservationId: r.id, type: "RENTAL", idempotencyKey: op.key } }) : null;
  const amountCents = payment?.amountCents ?? terms?.amount ?? deposit?.amountCents ?? null;
  const currency = payment?.currency ?? terms?.currency ?? deposit?.currency ?? null;
  await tx.financialCase.upsert({ where: { sourceKey: "operation:" + id }, update: { attempts: op.attempts, lastError: reason }, create: {
    sourceKey: "operation:" + id, reservationId: r.id, customerId: r.customerId, operationId: id, kind: op.kind,
    amountCents, currency, originalKey: op.key, providerId: op.providerId, reason, attempts: op.attempts,
  } });
  await tx.reservation.update({ where: { id: r.id }, data: { financialDisposition: "REVIEW" } });
}

export async function quarantineRefund(tx: Prisma.TransactionClient, refundId: string, reason: string) {
 const f=await tx.refund.findUniqueOrThrow({where:{id:refundId}});
 const r=await tx.reservation.findUniqueOrThrow({where:{id:f.reservationId}});
 await tx.financialCase.upsert({where:{sourceKey:"refund:"+f.id},update:{reason,status:"OPEN",resolvedAt:null},create:{sourceKey:"refund:"+f.id,refundId:f.id,reservationId:r.id,customerId:r.customerId,kind:"REFUND",amountCents:f.amountCents,originalKey:f.idempotencyKey,providerId:f.stripeRefundId,reason}});
 await tx.reservation.update({where:{id:r.id},data:{financialDisposition:"REVIEW"}});
}
