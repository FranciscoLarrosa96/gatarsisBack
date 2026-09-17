import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource, QueryFailedError } from "typeorm";
import { DomainError } from "../common/domain-error";
import { Order, OrderStatus } from "../orders/entities/order.entity";
import {
  Payment,
  PaymentProcessingStatus,
} from "../payments/entities/payment.entity";
import {
  MERCADO_PAGO_GATEWAY,
  MercadoPagoGatewayContract,
} from "../payments/mercado-pago.gateway";
import {
  RefundOperation,
  RefundOperationStatus,
} from "../payments/entities/refund-operation.entity";
import { AdminAuditLog } from "./entities/admin-audit-log.entity";
import { Inject } from "@nestjs/common";

@Injectable()
export class AdminRefundsService {
  constructor(
    private readonly ds: DataSource,
    @Inject(MERCADO_PAGO_GATEWAY)
    private readonly gateway: MercadoPagoGatewayContract,
  ) {}
  private response(r: RefundOperation) {
    return {
      id: r.id,
      paymentId: r.paymentId,
      orderId: r.orderId,
      amountInCents: r.amountInCents,
      status: r.status,
      providerRefundId: r.providerRefundId ?? null,
      createdAt: r.createdAt,
      completedAt: r.completedAt ?? null,
    };
  }
  async refund(
    paymentId: string,
    adminUserId: string,
    idempotencyKey: string,
    reason: string,
  ) {
    if (!idempotencyKey?.trim())
      throw new DomainError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "El header Idempotency-Key es obligatorio.",
        undefined,
        400,
      );
    let operation: RefundOperation;
    let createdNow = false;
    try {
      operation = await this.ds.transaction(async (m) => {
        // Serialize equal idempotency keys before acquiring the Payment lock.
        // The UNIQUE constraint remains the cross-process correctness backstop.
        await m.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [idempotencyKey],
        );
        const existing = await m.findOneBy(RefundOperation, { idempotencyKey });
        if (existing) {
          if (existing.paymentId !== paymentId)
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "La clave de idempotencia ya pertenece a otro pago.",
              undefined,
              409,
            );
          return existing;
        }
        const payment = await m
          .createQueryBuilder(Payment, "p")
          .setLock("pessimistic_write")
          .where("p.id=:id", { id: paymentId })
          .getOne();
        if (!payment)
          throw new NotFoundException({ code: "PAYMENT_NOT_FOUND" });
        const order = await m
          .createQueryBuilder(Order, "o")
          .setLock("pessimistic_write")
          .where("o.id=:id", { id: payment.orderId })
          .getOneOrFail();
        const previous = await m.findOneBy(RefundOperation, {
          paymentId: payment.id,
          status: RefundOperationStatus.SUCCEEDED,
        });
        if (
          payment.provider !== "mercado_pago" ||
          payment.processingStatus !== PaymentProcessingStatus.APPLIED ||
          order.status !== OrderStatus.PAID ||
          previous
        )
          throw new DomainError(
            "PAYMENT_NOT_REFUNDABLE",
            "El pago no admite refund.",
            undefined,
            409,
          );
        const created = await m.save(RefundOperation, {
          paymentId: payment.id,
          orderId: order.id,
          adminUserId,
          idempotencyKey,
          amountInCents: payment.transactionAmountInCents,
          reason: reason.trim(),
          status: RefundOperationStatus.REQUESTING,
          providerRefundId: null,
          lastError: null,
          completedAt: null,
        });
        await m.save(AdminAuditLog, {
          adminUserId,
          action: "REFUND_REQUESTED",
          entityType: "REFUND_OPERATION",
          entityId: created.id,
          metadata: {
            refundOperationId: created.id,
            localPaymentId: payment.id,
            providerPaymentId: payment.providerPaymentId,
            orderId: order.id,
            amountInCents: created.amountInCents,
            reason: created.reason,
          },
        });
        createdNow = true;
        return created;
      });
    } catch (e) {
      if (
        e instanceof QueryFailedError &&
        (e as { code?: string }).code === "23505"
      ) {
        const existing = await this.ds
          .getRepository(RefundOperation)
          .findOneBy({ idempotencyKey });
        if (existing) return this.response(existing);
      }
      throw e;
    }
    if (!createdNow || operation.status !== RefundOperationStatus.REQUESTING)
      return this.response(operation);
    try {
      const providerRefund = await this.gateway.refundPayment(
        (
          await this.ds
            .getRepository(Payment)
            .findOneByOrFail({ id: paymentId })
        ).providerPaymentId,
        operation.idempotencyKey,
      );
      return await this.succeed(
        operation.id,
        providerRefund.id,
        "REFUND_SUCCEEDED",
      );
    } catch (error) {
      await this.ds
        .getRepository(RefundOperation)
        .update(
          { id: operation.id, status: RefundOperationStatus.REQUESTING },
          {
            status: RefundOperationStatus.REQUIRES_REVIEW,
            lastError:
              error instanceof Error ? error.message : "Unknown provider error",
          },
        );
      return this.response(
        await this.ds
          .getRepository(RefundOperation)
          .findOneByOrFail({ id: operation.id }),
      );
    }
  }
  private async succeed(id: string, providerRefundId: string, action: string) {
    return this.ds.transaction(async (m) => {
      const r = await m.findOneByOrFail(RefundOperation, { id });
      if (r.status === RefundOperationStatus.SUCCEEDED) return this.response(r);
      const order = await m.findOneByOrFail(Order, { id: r.orderId });
      r.status = RefundOperationStatus.SUCCEEDED;
      r.providerRefundId = providerRefundId;
      r.completedAt = new Date();
      r.lastError = null;
      order.status = OrderStatus.REFUNDED;
      await m.save(RefundOperation, r);
      await m.save(Order, order);
      await m.save(AdminAuditLog, {
        adminUserId: r.adminUserId,
        action,
        entityType: "REFUND_OPERATION",
        entityId: r.id,
        metadata: {
          refundOperationId: r.id,
          localPaymentId: r.paymentId,
          orderId: r.orderId,
          amountInCents: r.amountInCents,
          providerRefundId,
        },
      });
      return this.response(r);
    });
  }
  async reconcileRefundOperation(refundOperationId: string) {
    const operation = await this.ds.getRepository(RefundOperation).findOneBy({ id: refundOperationId });
    if (!operation) throw new NotFoundException({ code: 'REFUND_OPERATION_NOT_FOUND' });
    if (operation.status === RefundOperationStatus.SUCCEEDED) return this.response(operation);
    if (![RefundOperationStatus.REQUESTING, RefundOperationStatus.REQUIRES_REVIEW].includes(operation.status)) return this.response(operation);
    const payment = await this.ds.getRepository(Payment).findOneByOrFail({ id: operation.paymentId });
    try {
      const refunds = await this.gateway.listRefunds(payment.providerPaymentId);
      if (refunds.length) return this.succeed(operation.id, refunds[0].id, 'REFUND_RECONCILED');
      await this.ds.transaction(async (manager) => {
        await manager.update(RefundOperation, { id: operation.id }, { status: RefundOperationStatus.FAILED, lastError: 'Provider confirmed no full refund exists.' });
        await manager.save(AdminAuditLog, { adminUserId: operation.adminUserId, action: 'REFUND_FAILED', entityType: 'REFUND_OPERATION', entityId: operation.id, metadata: { refundOperationId: operation.id, localPaymentId: operation.paymentId, orderId: operation.orderId, amountInCents: operation.amountInCents, status: RefundOperationStatus.FAILED } });
      });
    } catch (error) {
      await this.ds.getRepository(RefundOperation).update({ id: operation.id }, { status: RefundOperationStatus.REQUIRES_REVIEW, lastError: error instanceof Error ? error.message : 'Unable to reconcile provider refund.' });
    }
    return this.response(await this.ds.getRepository(RefundOperation).findOneByOrFail({ id: operation.id }));
  }
}
