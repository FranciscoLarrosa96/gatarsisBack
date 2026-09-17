import { DataSource, EntityManager } from "typeorm";
import { AdminRefundsService } from "./admin-refunds.service";
import { AdminAuditLog } from "./entities/admin-audit-log.entity";
import { Order, OrderKind, OrderStatus } from "../orders/entities/order.entity";
import {
  RefundOperation,
  RefundOperationStatus,
} from "../payments/entities/refund-operation.entity";
import { MercadoPagoGatewayContract } from "../payments/mercado-pago.gateway";
import { Raffle, RaffleStatus } from "../raffles/entities/raffle.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "../raffles/entities/raffle-number.entity";

describe("AdminRefundsService raffle confirmation", () => {
  function fixture(status = RaffleStatus.ACTIVE, kind = OrderKind.RAFFLE) {
    const operation = {
      id: "refund",
      orderId: "order",
      paymentId: "payment",
      adminUserId: "admin",
      status: RefundOperationStatus.REQUIRES_REVIEW,
    } as RefundOperation;
    const order = {
      id: "order",
      kind,
      status: OrderStatus.PAID,
      totalInCents: 100,
    } as Order;
    const number = {
      id: "number",
      number: 7,
      raffleId: "raffle",
      rafflePurchaseId: "purchase",
      status: RaffleNumberStatus.SOLD,
      soldAt: new Date(),
      reservedAt: new Date(),
    };
    const builder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([number]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const save = jest.fn().mockImplementation(async (_entity, value) => value);
    const manager = {
      findOneOrFail: jest
        .fn()
        .mockImplementation(async (entity) =>
          entity === RefundOperation ? operation : order,
        ),
      findOneBy: jest.fn().mockResolvedValue({
        id: "purchase",
        raffleId: "raffle",
        orderId: "order",
        unitPriceInCents: 100,
      }),
      findOne: jest.fn().mockResolvedValue({ id: "raffle", status }),
      getRepository: jest
        .fn()
        .mockReturnValue({ createQueryBuilder: () => builder }),
      createQueryBuilder: jest.fn().mockReturnValue(builder),
      save,
    };
    const update = jest.fn();
    const ds = {
      getRepository: jest.fn().mockImplementation((entity) => ({
        findOneBy: async () => operation,
        findOneByOrFail: async () =>
          entity === RefundOperation ? operation : { providerPaymentId: "mp" },
        update,
      })),
      transaction: jest
        .fn()
        .mockImplementation(async (callback) =>
          callback(manager as unknown as EntityManager),
        ),
    };
    const gateway = {
      listRefunds: jest.fn().mockResolvedValue([{ id: "provider-refund" }]),
      refundPayment: jest.fn(),
    };
    const service = new AdminRefundsService(
      ds as unknown as DataSource,
      gateway as unknown as MercadoPagoGatewayContract,
    );
    return {
      service,
      manager,
      builder,
      operation,
      order,
      save,
      update,
      gateway,
    };
  }

  it("confirms and releases with locks, conditional ownership and historical audit", async () => {
    const f = fixture();
    expect(await f.service.reconcileRefundOperation("refund")).toMatchObject({
      status: "SUCCEEDED",
      providerRefundId: "provider-refund",
    });
    expect(f.order.status).toBe(OrderStatus.REFUNDED);
    expect(f.manager.findOne).toHaveBeenCalledWith(
      Raffle,
      expect.objectContaining({ lock: { mode: "pessimistic_write" } }),
    );
    expect(f.builder.setLock).toHaveBeenCalledWith("pessimistic_write");
    expect(f.builder.update).toHaveBeenCalledWith(RaffleNumber);
    expect(f.builder.where).toHaveBeenCalledWith(
      expect.stringContaining("raffle_purchase_id = :purchaseId"),
      expect.objectContaining({ purchaseId: "purchase", status: "SOLD" }),
    );
    expect(f.save).toHaveBeenCalledWith(
      AdminAuditLog,
      expect.objectContaining({
        action: "RAFFLE_REFUND_NUMBERS_RELEASED",
        metadata: expect.objectContaining({
          numbers: [7],
          associations: [
            expect.objectContaining({
              rafflePurchaseId: "purchase",
              soldAt: expect.any(Date),
            }),
          ],
        }),
      }),
    );
    await f.service.reconcileRefundOperation("refund");
    expect(f.builder.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    RaffleStatus.CLOSED,
    RaffleStatus.DRAWN,
    RaffleStatus.PAUSED,
    RaffleStatus.DRAFT,
  ])(
    "preserves numbers for %s without reverting the refund",
    async (status) => {
      const f = fixture(status);
      expect((await f.service.reconcileRefundOperation("refund")).status).toBe(
        "SUCCEEDED",
      );
      expect(f.order.status).toBe(OrderStatus.REFUNDED);
      expect(f.builder.execute).not.toHaveBeenCalled();
      expect(f.save).toHaveBeenCalledWith(
        AdminAuditLog,
        expect.objectContaining({
          action: "RAFFLE_REFUND_NUMBERS_RELEASE_SKIPPED",
          metadata: expect.objectContaining({
            processingResult: "RAFFLE_NOT_OPEN",
            raffleStatus: status,
          }),
        }),
      );
    },
  );

  it("does not touch raffle tables for merchandise", async () => {
    const f = fixture(RaffleStatus.ACTIVE, OrderKind.MERCH);
    await f.service.reconcileRefundOperation("refund");
    expect(f.manager.findOne).not.toHaveBeenCalled();
    expect(f.builder.execute).not.toHaveBeenCalled();
  });

  it("does not release while provider confirmation remains ambiguous", async () => {
    const f = fixture();
    f.gateway.listRefunds.mockRejectedValueOnce(new Error("lookup timeout"));
    await f.service.reconcileRefundOperation("refund");
    expect(f.builder.execute).not.toHaveBeenCalled();
    expect(f.order.status).toBe(OrderStatus.PAID);
  });

  it("does not process a failed refund", async () => {
    const f = fixture();
    f.operation.status = RefundOperationStatus.FAILED;
    await f.service.reconcileRefundOperation("refund");
    expect(f.gateway.listRefunds).not.toHaveBeenCalled();
    expect(f.builder.execute).not.toHaveBeenCalled();
  });

  it("rejects ownership mismatches before updating numbers", async () => {
    const f = fixture();
    f.builder.getMany.mockResolvedValueOnce([]);
    await f.service.reconcileRefundOperation("refund");
    expect(f.builder.execute).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lastError: "RAFFLE_REFUND_NUMBER_OWNERSHIP_CONFLICT",
      }),
    );
  });

  it("catches local reconciliation failure for review without a provider refund call", async () => {
    const f = fixture();
    f.builder.execute.mockRejectedValueOnce(new Error("local release failure"));
    await f.service.reconcileRefundOperation("refund");
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "refund" }),
      expect.objectContaining({
        status: "REQUIRES_REVIEW",
        lastError: "local release failure",
      }),
    );
    expect(f.gateway.refundPayment).not.toHaveBeenCalled();
  });
});
