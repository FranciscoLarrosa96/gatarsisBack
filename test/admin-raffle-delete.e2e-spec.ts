import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import request = require("supertest");
import { DataSource } from "typeorm";
import { AdminAuditLog } from "../src/admin/entities/admin-audit-log.entity";
import { AdminRole, AdminUser } from "../src/admin/entities/admin-user.entity";
import { AppModule } from "../src/app.module";
import {
  Order,
  OrderKind,
  OrderStatus,
} from "../src/orders/entities/order.entity";
import {
  Payment,
  PaymentProcessingStatus,
} from "../src/payments/entities/payment.entity";
import {
  PaymentPreference,
  PaymentPreferenceStatus,
} from "../src/payments/entities/payment-preference.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "../src/raffles/entities/raffle-number.entity";
import { RafflePurchase } from "../src/raffles/entities/raffle-purchase.entity";
import { Raffle, RaffleStatus } from "../src/raffles/entities/raffle.entity";

describe("admin safe raffle deletion (PostgreSQL)", () => {
  let app: INestApplication;
  let ds: DataSource;
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.DATABASE_NAME ??= "gatarsis_test";
    process.env.MP_ENABLED = "false";
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    await ds.runMigrations();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await ds.query(
      "TRUNCATE adoptable_cats, raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, refund_operations, webhook_events, inventory_movements, payments, payment_preferences, order_fulfillments, order_items, orders, inventory, product_media, product_variants, products RESTART IDENTITY CASCADE",
    );
    const admin = await ds.getRepository(AdminUser).save({
      email: `raffle-delete-${crypto.randomUUID()}@example.test`,
      passwordHash: await bcrypt.hash("CorrectHorseBatteryStaple!", 4),
      role: AdminRole.ADMIN,
      active: true,
      lastLoginAt: null,
    });
    token = (
      await request(app.getHttpServer())
        .post("/api/v1/admin/auth/login")
        .set("X-Forwarded-For", crypto.randomUUID())
        .send({ email: admin.email, password: "CorrectHorseBatteryStaple!" })
        .expect(200)
    ).body.accessToken;
  });

  async function raffle(status = RaffleStatus.DRAFT) {
    return ds.transaction(async (manager) => {
      const created = await manager.save(Raffle, {
        title: "Rifa eliminable",
        prizeName: "Premio de prueba",
        description: null,
        imageUrls: [],
        priceInCents: 10_000,
        status,
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

  async function purchase(
    raffleId: string,
    status: OrderStatus,
    numberStatus: RaffleNumberStatus,
    expiresAt: Date,
  ) {
    const order = await ds.getRepository(Order).save({
      kind: OrderKind.RAFFLE,
      status,
      idempotencyKey: crypto.randomUUID(),
      requestFingerprint: crypto.randomUUID(),
      subtotalInCents: 10_000,
      totalInCents: 10_000,
      reservationExpiresAt: expiresAt,
      paidAt: status === OrderStatus.PAID ? new Date() : null,
    });
    const created = await ds.getRepository(RafflePurchase).save({
      raffleId,
      orderId: order.id,
      buyerName: "Test Buyer",
      buyerEmail: "buyer@example.test",
      buyerPhone: "+54 249 1234567",
      unitPriceInCents: 10_000,
      manualPaymentMethod: null,
      manualPaymentNote: null,
    });
    await ds.getRepository(RaffleNumber).update(
      { raffleId, number: 12 },
      {
        status: numberStatus,
        rafflePurchaseId: created.id,
        reservedAt: new Date(expiresAt.getTime() - 60_000),
        reservedUntil:
          numberStatus === RaffleNumberStatus.RESERVED ? expiresAt : null,
        soldAt: numberStatus === RaffleNumberStatus.SOLD ? new Date() : null,
      },
    );
    return { order, purchase: created };
  }

  function remove(id: string) {
    return request(app.getHttpServer())
      .delete(`/api/v1/admin/raffles/${id}`)
      .set(auth());
  }

  it("deletes a raffle without activity and its generated number grid", async () => {
    const created = await raffle();
    await remove(created.id).expect(204);
    expect(await ds.getRepository(Raffle).countBy({ id: created.id })).toBe(0);
    expect(
      await ds.getRepository(RaffleNumber).countBy({ raffleId: created.id }),
    ).toBe(0);
    const audit = await ds.getRepository(AdminAuditLog).findOneByOrFail({
      action: "RAFFLE_DELETED",
      entityId: created.id,
    });
    expect(audit.metadata).toEqual({
      raffleId: created.id,
      removedNumbers: 100,
      removedPurchases: 0,
      removedOrders: 0,
    });
  });

  it("returns 404 for an unknown raffle", async () => {
    const response = await remove(crypto.randomUUID()).expect(404);
    expect(response.body.code).toBe("RAFFLE_NOT_FOUND");
  });

  it("returns 409 and retains every record when a payment exists", async () => {
    const created = await raffle(RaffleStatus.ACTIVE);
    const fixture = await purchase(
      created.id,
      OrderStatus.EXPIRED,
      RaffleNumberStatus.RESERVED,
      new Date(Date.now() - 60_000),
    );
    await ds.getRepository(Payment).save({
      orderId: fixture.order.id,
      provider: "mercado_pago",
      providerPaymentId: `payment-${crypto.randomUUID()}`,
      providerStatus: "rejected",
      providerStatusDetail: "cc_rejected_other_reason",
      processingStatus: PaymentProcessingStatus.RECORDED,
      transactionAmountInCents: 10_000,
      currencyId: "ARS",
      externalReference: fixture.order.id,
      paymentMethodId: "visa",
      paymentTypeId: "credit_card",
      dateCreated: new Date(),
      dateApproved: null,
      dateLastUpdated: new Date(),
      reviewReason: null,
      reviewResolvedAt: null,
      reviewResolvedByAdminId: null,
      reviewResolution: null,
      reviewNote: null,
    });
    const response = await remove(created.id).expect(409);
    expect(response.body.code).toBe("RAFFLE_DELETE_NOT_ALLOWED");
    expect(response.body.details.reasons).toContain("PAYMENTS");
    expect(await ds.getRepository(Raffle).countBy({ id: created.id })).toBe(1);
    expect(await ds.getRepository(Payment).count()).toBe(1);
  });

  it("returns 409 for a paid sale even when no Mercado Pago Payment exists", async () => {
    const created = await raffle(RaffleStatus.ACTIVE);
    await purchase(
      created.id,
      OrderStatus.PAID,
      RaffleNumberStatus.SOLD,
      new Date(),
    );
    const response = await remove(created.id).expect(409);
    expect(response.body.code).toBe("RAFFLE_DELETE_NOT_ALLOWED");
    expect(response.body.details.reasons).toEqual(
      expect.arrayContaining(["SOLD_NUMBERS", "TERMINAL_PAID_ORDERS"]),
    );
    expect(await ds.getRepository(RafflePurchase).count()).toBe(1);
    expect(await ds.getRepository(Order).count()).toBe(1);
  });

  it("deletes only permitted expired test dependencies in FK-safe order", async () => {
    const created = await raffle(RaffleStatus.CLOSED);
    const fixture = await purchase(
      created.id,
      OrderStatus.EXPIRED,
      RaffleNumberStatus.RESERVED,
      new Date(Date.now() - 60_000),
    );
    await ds.getRepository(PaymentPreference).save({
      orderId: fixture.order.id,
      provider: "mercado_pago",
      providerPreferenceId: null,
      status: PaymentPreferenceStatus.FAILED,
      initPoint: null,
      lastErrorCode: "TEST_FAILURE",
      lastErrorAt: new Date(),
      readyAt: null,
      lastReconciliationAt: null,
    });
    await remove(created.id).expect(204);
    expect(await ds.getRepository(Raffle).count()).toBe(0);
    expect(await ds.getRepository(RaffleNumber).count()).toBe(0);
    expect(await ds.getRepository(RafflePurchase).count()).toBe(0);
    expect(await ds.getRepository(PaymentPreference).count()).toBe(0);
    expect(await ds.getRepository(Order).count()).toBe(0);
  });

  it("rejects a still-active reservation without deleting it", async () => {
    const created = await raffle(RaffleStatus.ACTIVE);
    await purchase(
      created.id,
      OrderStatus.AWAITING_PAYMENT,
      RaffleNumberStatus.RESERVED,
      new Date(Date.now() + 10 * 60_000),
    );
    const response = await remove(created.id).expect(409);
    expect(response.body.details.reasons).toEqual(
      expect.arrayContaining(["ACTIVE_RESERVATIONS", "ACTIVE_ORDERS"]),
    );
  });

  it("rolls back number deletion and audit when deleting the raffle fails", async () => {
    const created = await raffle();
    await ds.query(`
      CREATE FUNCTION fail_raffle_delete_test() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced raffle delete failure'; END;
      $$ LANGUAGE plpgsql
    `);
    await ds.query(`
      CREATE TRIGGER trg_fail_raffle_delete_test
      BEFORE DELETE ON raffles
      FOR EACH ROW EXECUTE FUNCTION fail_raffle_delete_test()
    `);
    try {
      await remove(created.id).expect(500);
      expect(await ds.getRepository(Raffle).countBy({ id: created.id })).toBe(1);
      expect(
        await ds.getRepository(RaffleNumber).countBy({ raffleId: created.id }),
      ).toBe(100);
      expect(
        await ds.getRepository(AdminAuditLog).countBy({
          action: "RAFFLE_DELETED",
          entityId: created.id,
        }),
      ).toBe(0);
    } finally {
      await ds.query(
        "DROP TRIGGER IF EXISTS trg_fail_raffle_delete_test ON raffles",
      );
      await ds.query("DROP FUNCTION IF EXISTS fail_raffle_delete_test() ");
    }
  });

  it("protects the endpoint with existing admin authentication", async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/raffles/${crypto.randomUUID()}`)
      .expect(401);
  });
});
