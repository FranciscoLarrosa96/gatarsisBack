import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request = require("supertest");
import { DataSource } from "typeorm";
import { AdminRefundsService } from "../src/admin/admin-refunds.service";
import { AdminAuditLog } from "../src/admin/entities/admin-audit-log.entity";
import {
  RefundOperation,
  RefundOperationStatus,
} from "../src/payments/entities/refund-operation.entity";
import { AdminRole, AdminUser } from "../src/admin/entities/admin-user.entity";
import { AppModule } from "../src/app.module";
import { InventoryMovement } from "../src/inventory/entities/inventory-movement.entity";
import { OrderFulfillment } from "../src/orders/entities/order-fulfillment.entity";
import { OrderItem } from "../src/orders/entities/order-item.entity";
import { Order, OrderStatus } from "../src/orders/entities/order.entity";
import {
  PaymentPreference,
  PaymentPreferenceStatus,
} from "../src/payments/entities/payment-preference.entity";
import {
  Payment,
  PaymentProcessingStatus,
} from "../src/payments/entities/payment.entity";
import {
  MERCADO_PAGO_GATEWAY,
  MercadoPagoPayment,
} from "../src/payments/mercado-pago.gateway";
import { PaymentsService } from "../src/payments/payments.service";
import {
  WebhookEvent,
  WebhookEventStatus,
} from "../src/payments/entities/webhook-event.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "../src/raffles/entities/raffle-number.entity";
import { RafflePurchase } from "../src/raffles/entities/raffle-purchase.entity";
import { Raffle, RaffleStatus } from "../src/raffles/entities/raffle.entity";

describe("raffle payments R4 (PostgreSQL)", () => {
  let app: INestApplication;
  let ds: DataSource;
  let payments: PaymentsService;
  let refunds: AdminRefundsService;
  const remoteById = new Map<string, MercadoPagoPayment>();
  const createPreference = jest.fn();
  const searchPreferences = jest.fn();
  const getPayment = jest.fn();
  const searchPayments = jest.fn();
  const refundPayment = jest.fn();
  const listRefunds = jest.fn();
  const validateWebhookSignature = jest.fn();

  beforeAll(async () => {
    process.env.DATABASE_NAME ??= "gatarsis_test";
    process.env.MP_ENABLED = "true";
    process.env.MP_ACCESS_TOKEN = "test-token";
    process.env.MP_WEBHOOK_SECRET = "test-secret";
    process.env.FRONTEND_URL = "https://gatarsis.com.ar/";
    process.env.MP_RECONCILIATION_GRACE_SECONDS = "0";
    process.env.MP_PENDING_REVIEW_HOURS = "1";
    process.env.MP_PREFERENCE_CREATING_STALE_SECONDS = "1";
    process.env.MP_PREFERENCE_RECOVERY_CONFIRM_SECONDS = "1";
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MERCADO_PAGO_GATEWAY)
      .useValue({
        createPreference,
        searchPreferencesByExternalReference: searchPreferences,
        getPayment,
        searchPaymentsByExternalReference: searchPayments,
        refundPayment,
        listRefunds,
        validateWebhookSignature,
      })
      .compile();
    app = module.createNestApplication();
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    ds = app.get(DataSource);
    payments = app.get(PaymentsService);
    refunds = app.get(AdminRefundsService);
    await ds.runMigrations();
  });

  afterAll(async () => app.close());

  beforeEach(async () => {
    await ds.query(
      "TRUNCATE raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, refund_operations, webhook_events, inventory_movements, payments, payment_preferences, order_fulfillments, order_items, orders, inventory, product_media, product_variants, products RESTART IDENTITY CASCADE",
    );
    remoteById.clear();
    createPreference.mockReset().mockResolvedValue({
      id: `pref-${crypto.randomUUID()}`,
      init_point: "https://mp.test/raffle",
    });
    searchPreferences.mockReset().mockResolvedValue([]);
    searchPayments.mockReset().mockResolvedValue([]);
    getPayment.mockReset().mockImplementation(async (id: string) => {
      const remote = remoteById.get(id);
      if (!remote) throw new Error("PAYMENT_NOT_FOUND");
      return remote;
    });
    refundPayment
      .mockReset()
      .mockResolvedValue({ id: `refund-${crypto.randomUUID()}` });
    validateWebhookSignature.mockReset();
    listRefunds.mockReset().mockResolvedValue([]);
  });

  async function raffle() {
    return ds.transaction(async (manager) => {
      const created = await manager.save(Raffle, {
        title: "Rifa Gatarsis",
        prizeName: "Una bicicleta",
        description: null,
        imageUrl: "https://res.cloudinary.com/demo/image/upload/prize.jpg",
        priceInCents: 50_000,
        status: RaffleStatus.ACTIVE,
        drawAt: null,
        winningNumber: null,
        drawnAt: null,
        drawnByAdminId: null,
      });
      await manager.insert(
        RaffleNumber,
        Array.from({ length: 100 }, (_, number) => ({
          raffleId: created.id,
          number,
          status: RaffleNumberStatus.AVAILABLE,
          rafflePurchaseId: null,
          reservedAt: null,
          reservedUntil: null,
          soldAt: null,
        })),
      );
      return created;
    });
  }

  async function reserve(numbers = [7, 23, 65], raffleId?: string) {
    const active = raffleId
      ? await ds.getRepository(Raffle).findOneByOrFail({ id: raffleId })
      : await raffle();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/raffles/${active.id}/reservations`)
      .set("Idempotency-Key", crypto.randomUUID())
      .set("X-Forwarded-For", crypto.randomUUID())
      .send({
        numbers,
        buyerName: "Buyer Test",
        buyerEmail: `${crypto.randomUUID()}@example.test`,
        buyerPhone: "+54 249 1234567",
      })
      .expect(201);
    return {
      raffle: active,
      purchase: await ds.getRepository(RafflePurchase).findOneByOrFail({
        id: response.body.rafflePurchaseId,
      }),
      order: await ds.getRepository(Order).findOneByOrFail({
        id: response.body.orderId,
      }),
    };
  }

  const remote = (
    order: Order,
    status = "approved",
    id = `payment-${crypto.randomUUID()}`,
    amount = order.totalInCents / 100,
  ): MercadoPagoPayment => ({
    id,
    status,
    transaction_amount: amount,
    currency_id: "ARS",
    external_reference: order.id,
  });

  async function numbersFor(purchaseId: string) {
    return ds.getRepository(RaffleNumber).find({
      where: { rafflePurchaseId: purchaseId },
      order: { number: "ASC" },
    });
  }

  async function expectNoMerchArtifacts(orderId: string) {
    expect(await ds.getRepository(OrderItem).countBy({ orderId })).toBe(0);
    expect(await ds.getRepository(InventoryMovement).countBy({ orderId })).toBe(
      0,
    );
    expect(await ds.getRepository(OrderFulfillment).countBy({ orderId })).toBe(
      0,
    );
  }

  it("creates and reuses the hardened PaymentPreference with one logical raffle item", async () => {
    const { purchase, order } = await reserve();
    const first = await request(app.getHttpServer())
      .post(`/api/v1/raffle-purchases/${purchase.id}/mercado-pago/preference`)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/api/v1/raffle-purchases/${purchase.id}/mercado-pago/preference`)
      .expect(201);
    expect(second.body).toEqual(first.body);
    expect(createPreference).toHaveBeenCalledTimes(1);
    const payload = createPreference.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({
        external_reference: order.id,
        auto_return: "approved",
        items: [
          expect.objectContaining({
            title: "Rifa solidaria — Una bicicleta",
            description: "Números: 07, 23, 65",
            quantity: 3,
            unit_price: 500,
            currency_id: "ARS",
          }),
        ],
      }),
    );
    expect(payload).not.toHaveProperty("notification_url");
    expect(
      await ds.getRepository(PaymentPreference).findOneByOrFail({
        orderId: order.id,
      }),
    ).toMatchObject({ status: PaymentPreferenceStatus.READY });
  });

  it("single-flights concurrent creation and recovers a stale CREATING by external_reference", async () => {
    const { purchase, order } = await reserve();
    let finish!: (value: { id: string; init_point: string }) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    createPreference.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          signalStarted();
        }),
    );
    const first = request(app.getHttpServer())
      .post(`/api/v1/raffle-purchases/${purchase.id}/mercado-pago/preference`)
      .then((response) => response);
    await started;
    const second = await request(app.getHttpServer()).post(
      `/api/v1/raffle-purchases/${purchase.id}/mercado-pago/preference`,
    );
    finish({ id: "single", init_point: "https://mp.test/single" });
    expect((await first).status).toBe(201);
    expect(second.status).toBe(409);
    expect(createPreference).toHaveBeenCalledTimes(1);

    await ds.getRepository(PaymentPreference).update(
      { orderId: order.id },
      {
        status: PaymentPreferenceStatus.CREATING,
        providerPreferenceId: null,
        initPoint: null,
      },
    );
    await ds.query(
      "UPDATE payment_preferences SET updated_at = NOW() - INTERVAL '5 seconds' WHERE order_id = $1",
      [order.id],
    );
    searchPreferences.mockResolvedValueOnce([
      { id: "recovered", init_point: "https://mp.test/recovered" },
    ]);
    const recovered = await request(app.getHttpServer())
      .post(`/api/v1/raffle-purchases/${purchase.id}/mercado-pago/preference`)
      .expect(201);
    expect(recovered.body.preferenceId).toBe("recovered");
    expect(createPreference).toHaveBeenCalledTimes(1);
  });

  it("rejects expired and internally inconsistent reservations before calling MP", async () => {
    const expired = await reserve();
    await ds.getRepository(Order).update(expired.order.id, {
      reservationExpiresAt: new Date(Date.now() - 1_000),
    });
    expect(
      (
        await request(app.getHttpServer()).post(
          `/api/v1/raffle-purchases/${expired.purchase.id}/mercado-pago/preference`,
        )
      ).body.code,
    ).toBe("RAFFLE_RESERVATION_EXPIRED");

    const inconsistent = await reserve([8, 9, 10], expired.raffle.id);
    const number = (await numbersFor(inconsistent.purchase.id))[0];
    await ds.getRepository(RaffleNumber).update(number.id, {
      status: RaffleNumberStatus.AVAILABLE,
      rafflePurchaseId: null,
      reservedAt: null,
      reservedUntil: null,
    });
    expect(
      (
        await request(app.getHttpServer()).post(
          `/api/v1/raffle-purchases/${inconsistent.purchase.id}/mercado-pago/preference`,
        )
      ).body.code,
    ).toBe("RAFFLE_RESERVATION_OWNERSHIP_CONFLICT");
    expect(createPreference).toHaveBeenCalledTimes(0);
  });

  it("settles approved exactly once under 10 concurrent executions", async () => {
    const { purchase, order } = await reserve();
    const approved = remote(order);
    await Promise.all(
      Array.from({ length: 10 }, () => payments.recordAndApply(approved)),
    );
    const sold = await numbersFor(purchase.id);
    expect(sold).toHaveLength(3);
    expect(sold.every((item) => item.status === RaffleNumberStatus.SOLD)).toBe(
      true,
    );
    expect(sold.every((item) => item.soldAt !== null)).toBe(true);
    expect(sold.every((item) => item.reservedAt !== null)).toBe(true);
    expect(sold.every((item) => item.reservedUntil === null)).toBe(true);
    const soldAt = sold.map((item) => item.soldAt?.toISOString());
    await payments.recordAndApply(approved);
    expect(
      (await numbersFor(purchase.id)).map((item) => item.soldAt?.toISOString()),
    ).toEqual(soldAt);
    expect(
      await ds.getRepository(Order).findOneByOrFail({ id: order.id }),
    ).toMatchObject({ status: OrderStatus.PAID });
    expect(
      await ds.getRepository(Payment).findOneByOrFail({
        providerPaymentId: approved.id,
      }),
    ).toMatchObject({ processingStatus: PaymentProcessingStatus.APPLIED });
    await expectNoMerchArtifacts(order.id);
  });

  it("keeps pending reserved and fail-closes when reconciliation cannot reach MP", async () => {
    const fixture = await reserve();
    await payments.recordAndApply(remote(fixture.order, "pending"));
    await ds.getRepository(Order).update(fixture.order.id, {
      reservationExpiresAt: new Date(Date.now() - 10_000),
    });
    searchPayments.mockRejectedValueOnce(new Error("timeout"));
    await payments.reconcileExpiredReservations();
    expect(
      await ds.getRepository(Order).findOneByOrFail({ id: fixture.order.id }),
    ).toMatchObject({ status: OrderStatus.PAYMENT_PENDING });
    expect(
      (await numbersFor(fixture.purchase.id)).every(
        (item) => item.status === RaffleNumberStatus.RESERVED,
      ),
    ).toBe(true);
  });

  it.each(["rejected", "cancelled"])(
    "reconciles provider %s by releasing once",
    async (providerStatus) => {
      const fixture = await reserve();
      await ds.getRepository(Order).update(fixture.order.id, {
        reservationExpiresAt: new Date(Date.now() - 10_000),
      });
      searchPayments.mockResolvedValue([remote(fixture.order, providerStatus)]);
      await payments.reconcileExpiredReservations();
      await payments.reconcileExpiredReservations();
      expect(
        await ds.getRepository(Order).findOneByOrFail({ id: fixture.order.id }),
      ).toMatchObject({ status: OrderStatus.EXPIRED });
      expect(
        await ds.getRepository(RaffleNumber).countBy({
          raffleId: fixture.raffle.id,
          status: RaffleNumberStatus.AVAILABLE,
        }),
      ).toBe(100);
      await expectNoMerchArtifacts(fixture.order.id);
    },
  );

  it("keeps provider pending inside the window, then releases with review after its deadline", async () => {
    const fixture = await reserve();
    const pending = remote(fixture.order, "in_process");
    await payments.recordAndApply(pending);
    searchPayments.mockResolvedValue([pending]);
    await ds.getRepository(Order).update(fixture.order.id, {
      reservationExpiresAt: new Date(Date.now() - 10_000),
    });
    await payments.reconcileExpiredReservations();
    expect(
      await ds.getRepository(Order).findOneByOrFail({ id: fixture.order.id }),
    ).toMatchObject({ status: OrderStatus.PAYMENT_PENDING });

    await ds.getRepository(Order).update(fixture.order.id, {
      reservationExpiresAt: new Date(Date.now() - 2 * 3_600_000),
    });
    await payments.reconcileExpiredReservations();
    expect(
      await ds.getRepository(Order).findOneByOrFail({ id: fixture.order.id }),
    ).toMatchObject({ status: OrderStatus.EXPIRED });
    expect(
      await ds.getRepository(Payment).findOneByOrFail({
        providerPaymentId: pending.id,
      }),
    ).toMatchObject({
      processingStatus: PaymentProcessingStatus.REQUIRES_REVIEW,
      reviewReason: "PENDING_REVIEW_DEADLINE_REACHED",
    });
    expect(await numbersFor(fixture.purchase.id)).toHaveLength(0);
  });

  it("never takes a number from B when A is approved after release and resale", async () => {
    const active = await raffle();
    const a = await reserve([37], active.id);
    await ds.getRepository(Order).update(a.order.id, {
      reservationExpiresAt: new Date(Date.now() - 10_000),
    });
    searchPayments.mockResolvedValue([]);
    await payments.reconcileExpiredReservations();
    const b = await reserve([37], active.id);
    const late = remote(a.order, "approved");
    await payments.recordAndApply(late);
    expect(
      await ds.getRepository(Payment).findOneByOrFail({
        providerPaymentId: late.id,
      }),
    ).toMatchObject({
      processingStatus: PaymentProcessingStatus.REQUIRES_REVIEW,
      reviewReason: "LATE_APPROVED_AFTER_RELEASE",
    });
    expect(
      await ds.getRepository(RaffleNumber).findOneByOrFail({
        raffleId: active.id,
        number: 37,
      }),
    ).toMatchObject({
      status: RaffleNumberStatus.RESERVED,
      rafflePurchaseId: b.purchase.id,
    });
  });

  it("sends ownership and amount conflicts to review without partial settlement", async () => {
    const ownership = await reserve();
    const stolen = (await numbersFor(ownership.purchase.id))[0];
    await ds.getRepository(RaffleNumber).update(stolen.id, {
      status: RaffleNumberStatus.AVAILABLE,
      rafflePurchaseId: null,
      reservedAt: null,
      reservedUntil: null,
    });
    const ownershipPayment = remote(ownership.order);
    await payments.recordAndApply(ownershipPayment);
    expect(
      await ds.getRepository(Payment).findOneByOrFail({
        providerPaymentId: ownershipPayment.id,
      }),
    ).toMatchObject({
      processingStatus: PaymentProcessingStatus.REQUIRES_REVIEW,
      reviewReason: "RAFFLE_RESERVATION_OWNERSHIP_CONFLICT",
    });
    expect(
      await ds.getRepository(Order).findOneByOrFail({ id: ownership.order.id }),
    ).toMatchObject({ status: OrderStatus.AWAITING_PAYMENT });

    const amount = await reserve([11, 12, 13], ownership.raffle.id);
    const wrongAmount = remote(amount.order, "approved", undefined, 1);
    await payments.recordAndApply(wrongAmount);
    expect(
      await ds.getRepository(Payment).findOneByOrFail({
        providerPaymentId: wrongAmount.id,
      }),
    ).toMatchObject({
      processingStatus: PaymentProcessingStatus.REQUIRES_REVIEW,
      reviewReason: "PAYMENT_VALIDATION_FAILED",
    });
    expect(
      (await numbersFor(amount.purchase.id)).every(
        (item) => item.status === RaffleNumberStatus.RESERVED,
      ),
    ).toBe(true);
  });

  it("processes a valid inbox webhook immediately for RAFFLE", async () => {
    const fixture = await reserve();
    const approved = remote(fixture.order, "approved", "raffle-provider-123");
    remoteById.set(approved.id, approved);
    await request(app.getHttpServer())
      .post(`/api/v1/webhooks/mercado-pago?data.id=${approved.id}`)
      .set("x-signature", "valid-test-signature")
      .set("x-request-id", "raffle-request")
      .send({
        id: "notification-raffle-1",
        type: "payment",
        action: "payment.updated",
        data: { id: approved.id },
      })
      .expect(200);
    expect(validateWebhookSignature).toHaveBeenCalledTimes(1);
    expect(getPayment).toHaveBeenCalledWith(approved.id);
    expect(getPayment).toHaveBeenCalledTimes(1);
    expect(
      await ds.getRepository(Order).findOneByOrFail({ id: fixture.order.id }),
    ).toMatchObject({ status: OrderStatus.PAID });
    expect(
      (await numbersFor(fixture.purchase.id)).every(
        (item) => item.status === RaffleNumberStatus.SOLD,
      ),
    ).toBe(true);
    await expectNoMerchArtifacts(fixture.order.id);
  });

  it("settles once when a valid webhook and early reconciliation race", async () => {
    const fixture = await reserve();
    await request(app.getHttpServer())
      .post(
        `/api/v1/raffle-purchases/${fixture.purchase.id}/mercado-pago/preference`,
      )
      .expect(201);
    await ds.query(
      "UPDATE orders SET created_at = NOW() - INTERVAL '5 minutes' WHERE id = $1",
      [fixture.order.id],
    );
    const approved = remote(fixture.order, "approved", "raffle-racing-payment");
    remoteById.set(approved.id, approved);
    searchPayments.mockResolvedValue([approved]);
    const webhook = request(app.getHttpServer())
      .post(`/api/v1/webhooks/mercado-pago?data.id=${approved.id}`)
      .set("x-signature", "valid-test-signature")
      .set("x-request-id", "raffle-race-request")
      .send({
        id: "notification-raffle-race",
        type: "payment",
        action: "payment.updated",
        data: { id: approved.id },
      })
      .then((response) => response);
    const [, webhookResponse] = await Promise.all([
      payments.earlyReconcilePendingOrders(),
      webhook,
    ]);
    expect(webhookResponse.status).toBe(200);
    expect(
      await ds.getRepository(Payment).countBy({
        providerPaymentId: approved.id,
        processingStatus: PaymentProcessingStatus.APPLIED,
      }),
    ).toBe(1);
    expect(
      (await numbersFor(fixture.purchase.id)).every(
        (item) => item.status === RaffleNumberStatus.SOLD,
      ),
    ).toBe(true);
    expect(
      await ds.getRepository(WebhookEvent).findOneByOrFail({
        providerEventId: "notification-raffle-race",
      }),
    ).toMatchObject({ status: WebhookEventStatus.PROCESSED });
    await expectNoMerchArtifacts(fixture.order.id);
  });

  it("exposes PII-free status and releases numbers after a confirmed refund of an ACTIVE raffle", async () => {
    const fixture = await reserve();
    const approved = remote(fixture.order);
    await payments.recordAndApply(approved);
    const status = await request(app.getHttpServer())
      .get(`/api/v1/raffle-purchases/${fixture.purchase.id}/status`)
      .expect(200);
    expect(status.body).toEqual(
      expect.objectContaining({
        rafflePurchaseId: fixture.purchase.id,
        orderId: fixture.order.id,
        status: "PAID",
        numbers: [7, 23, 65],
      }),
    );
    expect(JSON.stringify(status.body)).not.toContain("Buyer Test");
    expect(JSON.stringify(status.body)).not.toContain("example.test");

    const admin = await ds.getRepository(AdminUser).save({
      email: "raffle-refund@example.test",
      passwordHash: "not-used",
      role: AdminRole.ADMIN,
      active: true,
      lastLoginAt: null,
    });
    const localPayment = await ds.getRepository(Payment).findOneByOrFail({
      providerPaymentId: approved.id,
    });
    await refunds.refund(
      localPayment.id,
      admin.id,
      "raffle-refund-idempotency",
      "Solicitud del comprador",
    );
    expect(refundPayment).toHaveBeenCalledTimes(1);
    expect(
      await ds.getRepository(Order).findOneByOrFail({ id: fixture.order.id }),
    ).toMatchObject({ status: OrderStatus.REFUNDED });
    expect(await numbersFor(fixture.purchase.id)).toEqual([]);
    const released = await ds.getRepository(RaffleNumber).findBy({
      raffleId: fixture.raffle.id,
      status: RaffleNumberStatus.AVAILABLE,
    });
    expect(released).toHaveLength(100);
    expect(released.find((n) => n.number === 7)).toMatchObject({
      rafflePurchaseId: null,
      reservedAt: null,
      reservedUntil: null,
      soldAt: null,
    });
    const audit = await ds
      .getRepository(AdminAuditLog)
      .findOneByOrFail({ action: "RAFFLE_REFUND_NUMBERS_RELEASED" });
    expect(audit.metadata).toMatchObject({
      rafflePurchaseId: fixture.purchase.id,
      numbers: [7, 23, 65],
      processingResult: "RELEASED",
      associations: [
        expect.objectContaining({
          number: 7,
          rafflePurchaseId: fixture.purchase.id,
          soldAt: expect.any(String),
          reservedAt: expect.any(String),
        }),
        expect.any(Object),
        expect.any(Object),
      ],
    });
    const publicNumbers = await request(app.getHttpServer())
      .get(`/api/v1/raffles/${fixture.raffle.id}/numbers`)
      .expect(200);
    expect(
      publicNumbers.body.numbers.find((n: { number: number }) => n.number === 7)
        .status,
    ).toBe("AVAILABLE");
    await expectNoMerchArtifacts(fixture.order.id);
  });

  async function refundableFixture() {
    const fixture = await reserve([7]);
    const approved = remote(fixture.order);
    await payments.recordAndApply(approved);
    const payment = await ds
      .getRepository(Payment)
      .findOneByOrFail({ providerPaymentId: approved.id });
    const admin = await ds.getRepository(AdminUser).save({
      email: "refund-test@example.test",
      passwordHash: "not-used",
      role: AdminRole.ADMIN,
      active: true,
      lastLoginAt: null,
    });
    const key = crypto.randomUUID();
    const refund = () =>
      refunds.refund(payment.id, admin.id, key, "Solicitud del comprador");
    return { ...fixture, payment, admin, refund };
  }

  it.each([
    RaffleStatus.CLOSED,
    RaffleStatus.DRAWN,
    RaffleStatus.PAUSED,
    RaffleStatus.DRAFT,
  ])(
    "does not release refunded numbers for raffle status %s",
    async (status) => {
      const f = await refundableFixture();
      await ds.getRepository(Raffle).update(f.raffle.id, { status });
      expect(await f.refund()).toMatchObject({ status: "SUCCEEDED" });
      expect(
        await ds.getRepository(Order).findOneByOrFail({ id: f.order.id }),
      ).toMatchObject({ status: OrderStatus.REFUNDED });
      expect(await numbersFor(f.purchase.id)).toEqual([
        expect.objectContaining({ number: 7, status: RaffleNumberStatus.SOLD }),
      ]);
      expect(
        (
          await ds.getRepository(AdminAuditLog).findOneByOrFail({
            action: "RAFFLE_REFUND_NUMBERS_RELEASE_SKIPPED",
          })
        ).metadata,
      ).toMatchObject({
        raffleStatus: status,
        processingResult: "RAFFLE_NOT_OPEN",
      });
    },
  );

  it("keeps numbers sold during review and after a confirmed failed refund", async () => {
    const f = await refundableFixture();
    refundPayment.mockRejectedValueOnce(new Error("provider timeout"));
    const result = await f.refund();
    expect(result.status).toBe(RefundOperationStatus.REQUIRES_REVIEW);
    expect((await numbersFor(f.purchase.id))[0].status).toBe(
      RaffleNumberStatus.SOLD,
    );
    await refunds.reconcileRefundOperation(result.id);
    expect(
      await ds
        .getRepository(RefundOperation)
        .findOneByOrFail({ id: result.id }),
    ).toMatchObject({ status: RefundOperationStatus.FAILED });
    expect((await numbersFor(f.purchase.id))[0].status).toBe(
      RaffleNumberStatus.SOLD,
    );
    expect(
      await ds
        .getRepository(AdminAuditLog)
        .countBy({ action: "RAFFLE_REFUND_NUMBERS_RELEASED" }),
    ).toBe(0);
  });

  it("serializes duplicate confirmation and never releases a later reservation or sale", async () => {
    const f = await refundableFixture();
    refundPayment.mockRejectedValueOnce(new Error("timeout after refund"));
    const op = await f.refund();
    listRefunds.mockResolvedValue([{ id: "confirmed-refund" }]);
    await Promise.all([
      refunds.reconcileRefundOperation(op.id),
      refunds.reconcileRefundOperation(op.id),
    ]);
    expect(
      await ds
        .getRepository(AdminAuditLog)
        .countBy({ action: "RAFFLE_REFUND_NUMBERS_RELEASED" }),
    ).toBe(1);
    const b = await reserve([7], f.raffle.id);
    await f.refund();
    await refunds.reconcileRefundOperation(op.id);
    expect(await numbersFor(b.purchase.id)).toEqual([
      expect.objectContaining({
        number: 7,
        status: RaffleNumberStatus.RESERVED,
      }),
    ]);
    await payments.recordAndApply(remote(b.order));
    const before = await numbersFor(b.purchase.id);
    await f.refund();
    await refunds.reconcileRefundOperation(op.id);
    expect(await numbersFor(b.purchase.id)).toEqual(before);
    expect(before[0].status).toBe(RaffleNumberStatus.SOLD);
    expect(refundPayment).toHaveBeenCalledTimes(1);
    expect(await ds.getRepository(RafflePurchase).count()).toBe(2);
  });

  it("rolls back local release failures and reconciles without another provider refund", async () => {
    const f = await refundableFixture();
    await ds.query(
      "CREATE FUNCTION fail_raffle_refund_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status = 'SOLD' AND NEW.status = 'AVAILABLE' THEN RAISE EXCEPTION 'forced number release failure'; END IF; RETURN NEW; END; $$",
    );
    await ds.query(
      "CREATE TRIGGER fail_raffle_refund_test BEFORE UPDATE ON raffle_numbers FOR EACH ROW EXECUTE FUNCTION fail_raffle_refund_test()",
    );
    let opId: string;
    try {
      const op = await f.refund();
      opId = op.id;
      expect(op.status).toBe(RefundOperationStatus.REQUIRES_REVIEW);
      expect((await numbersFor(f.purchase.id))[0].status).toBe(
        RaffleNumberStatus.SOLD,
      );
      expect(
        await ds.getRepository(Order).findOneByOrFail({ id: f.order.id }),
      ).toMatchObject({ status: OrderStatus.PAID });
      expect(
        await ds
          .getRepository(AdminAuditLog)
          .countBy({ action: "RAFFLE_REFUND_NUMBERS_RELEASED" }),
      ).toBe(0);
      expect(
        (await ds.getRepository(RefundOperation).findOneByOrFail({ id: op.id }))
          .lastError,
      ).toContain("forced number release failure");
    } finally {
      await ds.query(
        "DROP TRIGGER IF EXISTS fail_raffle_refund_test ON raffle_numbers",
      );
      await ds.query("DROP FUNCTION IF EXISTS fail_raffle_refund_test()");
    }
    listRefunds.mockResolvedValue([{ id: "provider-already-refunded" }]);
    await refunds.reconcileRefundOperation(opId!);
    expect(await numbersFor(f.purchase.id)).toEqual([]);
    expect(
      await ds.getRepository(Order).findOneByOrFail({ id: f.order.id }),
    ).toMatchObject({ status: OrderStatus.REFUNDED });
    expect(refundPayment).toHaveBeenCalledTimes(1);
  });
});
