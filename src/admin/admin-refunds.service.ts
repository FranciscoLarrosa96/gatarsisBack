import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DataSource, EntityManager, In, QueryFailedError } from "typeorm";
import { DomainError } from "../common/domain-error";
import { Order, OrderKind, OrderStatus } from "../orders/entities/order.entity";
import { Raffle, RaffleStatus } from "../raffles/entities/raffle.entity";
import { RafflePurchase } from "../raffles/entities/raffle-purchase.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "../raffles/entities/raffle-number.entity";
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
  private readonly logger = new Logger(AdminRefundsService.name);
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
        await m.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          idempotencyKey,
        ]);
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
    if (!createdNow || operation.status !== RefundOperationStatus.REQUESTING) {
      if (operation.status === RefundOperationStatus.SUCCEEDED)
        this.logger.log({
          step: "refund_confirmation_skipped",
          refundOperationId: operation.id,
          orderId: operation.orderId,
          processingResult: "ALREADY_PROCESSED",
        });
      return this.response(operation);
    }
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
      this.logger.error({
        step: "refund_confirmation_requires_review",
        refundOperationId: operation.id,
        orderId: operation.orderId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      await this.ds.getRepository(RefundOperation).update(
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
    let releaseLog: Record<string, unknown> | undefined;
    const result = await this.ds.transaction(async (m) => {
      const r = await m.findOneOrFail(RefundOperation, {
        where: { id },
        lock: { mode: "pessimistic_write" },
      });
      if (r.status === RefundOperationStatus.SUCCEEDED) {
        releaseLog = {
          step: "raffle_refund_numbers_release_skipped",
          refundOperationId: r.id,
          orderId: r.orderId,
          processingResult: "ALREADY_PROCESSED",
        };
        return this.response(r);
      }
      const order = await m.findOneOrFail(Order, {
        where: { id: r.orderId },
        lock: { mode: "pessimistic_write" },
      });
      r.status = RefundOperationStatus.SUCCEEDED;
      r.providerRefundId = providerRefundId;
      r.completedAt = new Date();
      r.lastError = null;
      order.status = OrderStatus.REFUNDED;
      await m.save(RefundOperation, r);
      await m.save(Order, order);
      if (order.kind === OrderKind.RAFFLE)
        releaseLog = await this.releaseRefundedNumbers(m, order, r);
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
    // Only announce completion after the entire transaction has committed.
    if (releaseLog) this.logger.log(releaseLog);
    return result;
  }

  private async releaseRefundedNumbers(
    m: EntityManager,
    order: Order,
    refund: RefundOperation,
  ) {
    const purchase = await m.findOneBy(RafflePurchase, { orderId: order.id });
    const fields = {
      orderId: order.id,
      refundOperationId: refund.id,
      rafflePurchaseId: purchase?.id,
      raffleId: purchase?.raffleId,
    };
    const raffle = purchase
      ? await m.findOne(Raffle, {
          where: { id: purchase.raffleId },
          lock: { mode: "pessimistic_write" },
        })
      : null;
    if (!purchase || !raffle || raffle.status !== RaffleStatus.ACTIVE) {
      const metadata = {
        ...fields,
        raffleStatus: raffle?.status,
        processingResult: !purchase
          ? "PURCHASE_NOT_FOUND"
          : !raffle
            ? "RAFFLE_NOT_FOUND"
            : "RAFFLE_NOT_OPEN",
      };
      await m.save(AdminAuditLog, {
        adminUserId: refund.adminUserId,
        action: "RAFFLE_REFUND_NUMBERS_RELEASE_SKIPPED",
        entityType: "REFUND_OPERATION",
        entityId: refund.id,
        metadata,
      });
      return { step: "raffle_refund_numbers_release_skipped", ...metadata };
    }
    // Same raffle -> number lock order used by reservations and raffle lifecycle changes.
    const numbers = await m
      .getRepository(RaffleNumber)
      .createQueryBuilder("number")
      .setLock("pessimistic_write")
      .where("number.raffle_purchase_id = :purchaseId", {
        purchaseId: purchase.id,
      })
      .orderBy("number.number", "ASC")
      .getMany();
    this.logger.log({
      step: "raffle_refund_number_release_started",
      ...fields,
      numbers: numbers.map((n) => n.number),
    });
    if (
      numbers.length !== order.totalInCents / purchase.unitPriceInCents ||
      !numbers.length ||
      numbers.some(
        (n) => n.raffleId !== raffle.id || n.status !== RaffleNumberStatus.SOLD,
      )
    )
      throw new Error("RAFFLE_REFUND_NUMBER_OWNERSHIP_CONFLICT");
    // Durable historical association, including reservation and sale timestamps.
    // The FK on raffle_numbers is current ownership, not a historical join table.
    const metadata = {
      ...fields,
      raffleStatus: raffle.status,
      numbers: numbers.map((n) => n.number),
      numberCount: numbers.length,
      processingResult: "RELEASED",
      releasedAt: new Date().toISOString(),
      associations: numbers.map((n) => ({
        raffleNumberId: n.id,
        number: n.number,
        rafflePurchaseId: n.rafflePurchaseId,
        reservedAt: n.reservedAt,
        reservedUntil: n.reservedUntil,
        soldAt: n.soldAt,
      })),
    };
    await m.save(AdminAuditLog, {
      adminUserId: refund.adminUserId,
      action: "RAFFLE_REFUND_NUMBERS_RELEASED",
      entityType: "REFUND_OPERATION",
      entityId: refund.id,
      metadata,
    });
    const updated = await m
      .createQueryBuilder()
      .update(RaffleNumber)
      .set({
        status: RaffleNumberStatus.AVAILABLE,
        rafflePurchaseId: null,
        reservedAt: null,
        reservedUntil: null,
        soldAt: null,
      })
      .where(
        "raffle_purchase_id = :purchaseId AND raffle_id = :raffleId AND status = :status",
        {
          purchaseId: purchase.id,
          raffleId: raffle.id,
          status: RaffleNumberStatus.SOLD,
        },
      )
      .execute();
    if (updated.affected !== numbers.length)
      throw new Error("RAFFLE_REFUND_NUMBER_OWNERSHIP_CONFLICT");
    return { step: "raffle_refund_numbers_released", ...metadata };
  }
  async reconcileRefundOperation(refundOperationId: string) {
    const operation = await this.ds
      .getRepository(RefundOperation)
      .findOneBy({ id: refundOperationId });
    if (!operation)
      throw new NotFoundException({ code: "REFUND_OPERATION_NOT_FOUND" });
    if (operation.status === RefundOperationStatus.SUCCEEDED) {
      this.logger.log({
        step: "refund_confirmation_skipped",
        refundOperationId: operation.id,
        orderId: operation.orderId,
        processingResult: "ALREADY_PROCESSED",
      });
      return this.response(operation);
    }
    if (
      ![
        RefundOperationStatus.REQUESTING,
        RefundOperationStatus.REQUIRES_REVIEW,
      ].includes(operation.status)
    )
      return this.response(operation);
    const payment = await this.ds
      .getRepository(Payment)
      .findOneByOrFail({ id: operation.paymentId });
    try {
      const refunds = await this.gateway.listRefunds(payment.providerPaymentId);
      if (refunds.length)
        return await this.succeed(
          operation.id,
          refunds[0].id,
          "REFUND_RECONCILED",
        );
      await this.ds.transaction(async (manager) => {
        const updated = await manager.update(
          RefundOperation,
          {
            id: operation.id,
            status: In([
              RefundOperationStatus.REQUESTING,
              RefundOperationStatus.REQUIRES_REVIEW,
            ]),
          },
          {
            status: RefundOperationStatus.FAILED,
            lastError: "Provider confirmed no full refund exists.",
          },
        );
        if (!updated.affected) return;
        await manager.save(AdminAuditLog, {
          adminUserId: operation.adminUserId,
          action: "REFUND_FAILED",
          entityType: "REFUND_OPERATION",
          entityId: operation.id,
          metadata: {
            refundOperationId: operation.id,
            localPaymentId: operation.paymentId,
            orderId: operation.orderId,
            amountInCents: operation.amountInCents,
            status: RefundOperationStatus.FAILED,
          },
        });
      });
    } catch (error) {
      this.logger.error({
        step: "refund_reconciliation_requires_review",
        refundOperationId: operation.id,
        orderId: operation.orderId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      await this.ds.getRepository(RefundOperation).update(
        {
          id: operation.id,
          status: In([
            RefundOperationStatus.REQUESTING,
            RefundOperationStatus.REQUIRES_REVIEW,
          ]),
        },
        {
          status: RefundOperationStatus.REQUIRES_REVIEW,
          lastError:
            error instanceof Error
              ? error.message
              : "Unable to reconcile provider refund.",
        },
      );
    }
    return this.response(
      await this.ds
        .getRepository(RefundOperation)
        .findOneByOrFail({ id: operation.id }),
    );
  }
}
