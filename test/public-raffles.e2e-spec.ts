import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request = require("supertest");
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { Order, OrderKind, OrderStatus } from "../src/orders/entities/order.entity";
import {
  Payment,
  PaymentProcessingStatus,
} from "../src/payments/entities/payment.entity";
import { MERCADO_PAGO_GATEWAY } from "../src/payments/mercado-pago.gateway";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "../src/raffles/entities/raffle-number.entity";
import { RafflePurchase } from "../src/raffles/entities/raffle-purchase.entity";
import { Raffle, RaffleStatus } from "../src/raffles/entities/raffle.entity";

describe("public raffle API R6 (PostgreSQL)", () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    process.env.DATABASE_NAME ??= "gatarsis_test";
    process.env.MP_ENABLED = "true";
    process.env.MP_ACCESS_TOKEN = "test-token";
    process.env.MP_WEBHOOK_SECRET = "test-secret";
    process.env.FRONTEND_URL = "https://gatarsis.com.ar";
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MERCADO_PAGO_GATEWAY)
      .useValue({
        createPreference: jest.fn(),
        searchPreferencesByExternalReference: jest.fn(),
        getPayment: jest.fn(),
        searchPaymentsByExternalReference: jest.fn(),
        refundPayment: jest.fn(),
        listRefunds: jest.fn(),
        validateWebhookSignature: jest.fn(),
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
    await ds.runMigrations();
  });

  afterAll(async () => app.close());

  beforeEach(async () => {
    await ds.query(
      "TRUNCATE raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, refund_operations, webhook_events, inventory_movements, payments, payment_preferences, order_fulfillments, order_items, orders, inventory, product_media, product_variants, products RESTART IDENTITY CASCADE",
    );
  });

  async function raffle(
    status: RaffleStatus,
    overrides: Partial<Raffle> = {},
  ) {
    const entity = await ds.getRepository(Raffle).save({
      title: `Rifa ${status}`,
      prizeName: "Premio solidario",
      description: "Descripción pública",
      imageUrls: ["https://res.cloudinary.com/demo/image/upload/prize.jpg"],
      priceInCents: 50_000,
      status,
      drawAt: new Date("2027-01-31T20:00:00.000Z"),
      winningNumber: null,
      drawnAt: null,
      drawnByAdminId: null,
      ...overrides,
    });
    await ds.getRepository(RaffleNumber).insert(
      Array.from({ length: 100 }, (_, number) => ({
        raffleId: entity.id,
        number,
        status: RaffleNumberStatus.AVAILABLE,
        rafflePurchaseId: null,
        reservedAt: null,
        reservedUntil: null,
        soldAt: null,
      })),
    );
    return entity;
  }

  async function attachPurchase(
    raffleId: string,
    number: number,
    state: RaffleNumberStatus.RESERVED | RaffleNumberStatus.SOLD,
  ) {
    const now = new Date();
    const paid = state === RaffleNumberStatus.SOLD;
    const order = await ds.getRepository(Order).save({
      kind: OrderKind.RAFFLE,
      status: paid ? OrderStatus.PAID : OrderStatus.AWAITING_PAYMENT,
      idempotencyKey: crypto.randomUUID(),
      requestFingerprint: `fingerprint-${crypto.randomUUID()}`,
      subtotalInCents: 50_000,
      totalInCents: 50_000,
      reservationExpiresAt: new Date(now.getTime() + 15 * 60_000),
      paidAt: paid ? now : null,
    });
    const purchase = await ds.getRepository(RafflePurchase).save({
      raffleId,
      orderId: order.id,
      buyerName: "Persona Secreta",
      buyerEmail: "pii-secret@example.test",
      buyerPhone: "+54 249 555 0000",
      unitPriceInCents: 50_000,
    });
    await ds.getRepository(RaffleNumber).update(
      { raffleId, number },
      {
        status: state,
        rafflePurchaseId: purchase.id,
        reservedAt: now,
        reservedUntil: paid ? null : order.reservationExpiresAt,
        soldAt: paid ? now : null,
      },
    );
    if (paid)
      await ds.getRepository(Payment).save({
        orderId: order.id,
        provider: "mercado_pago",
        providerPaymentId: `provider-secret-${crypto.randomUUID()}`,
        providerStatus: "approved",
        providerStatusDetail: "accredited",
        processingStatus: PaymentProcessingStatus.APPLIED,
        transactionAmountInCents: 50_000,
        currencyId: "ARS",
        externalReference: order.id,
        paymentMethodId: "visa",
        paymentTypeId: "credit_card",
        dateCreated: now,
        dateApproved: now,
        dateLastUpdated: now,
        reviewReason: null,
        reviewResolvedAt: null,
        reviewResolvedByAdminId: null,
        reviewResolution: null,
        reviewNote: null,
      });
    return { order, purchase };
  }

  it("returns the single ACTIVE raffle with public metadata, stats and no-store", async () => {
    const active = await raffle(RaffleStatus.ACTIVE);
    await raffle(RaffleStatus.PAUSED);
    await raffle(RaffleStatus.CLOSED);
    await raffle(RaffleStatus.DRAFT);
    const response = await request(app.getHttpServer())
      .get("/api/v1/raffles/active")
      .expect(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).toEqual({
      id: active.id,
      title: "Rifa ACTIVE",
      prizeName: "Premio solidario",
      description: "Descripción pública",
      imageUrls: ["https://res.cloudinary.com/demo/image/upload/prize.jpg"],
      imageUrl: "https://res.cloudinary.com/demo/image/upload/prize.jpg",
      priceInCents: 50_000,
      status: RaffleStatus.ACTIVE,
      drawAt: "2027-01-31T20:00:00.000Z",
      stats: { available: 100, reserved: 0, sold: 0, total: 100 },
    });
  });

  it.each([
    RaffleStatus.DRAFT,
    RaffleStatus.PAUSED,
    RaffleStatus.CLOSED,
  ])("does not use %s as an active fallback", async (status) => {
    await raffle(status);
    const response = await request(app.getHttpServer())
      .get("/api/v1/raffles/active")
      .expect(404);
    expect(response.body.code).toBe("RAFFLE_ACTIVE_NOT_FOUND");
  });

  it("returns RAFFLE_ACTIVE_NOT_FOUND when there are no raffles", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/raffles/active")
      .expect(404);
    expect(response.body.code).toBe("RAFFLE_ACTIVE_NOT_FOUND");
  });

  it.each([
    RaffleStatus.ACTIVE,
    RaffleStatus.PAUSED,
    RaffleStatus.CLOSED,
  ])("exposes %s detail without draw-only fields", async (status) => {
    const entity = await raffle(status);
    const response = await request(app.getHttpServer())
      .get(`/api/v1/raffles/${entity.id}`)
      .expect(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body.status).toBe(status);
    expect(response.body.stats.total).toBe(100);
    expect(response.body).not.toHaveProperty("winningNumber");
    expect(response.body).not.toHaveProperty("drawnAt");
  });

  it("exposes DRAWN result without winner identity or admin identity", async () => {
    const drawnAt = new Date("2027-02-01T00:00:00.000Z");
    const entity = await raffle(RaffleStatus.DRAWN, {
      winningNumber: 7,
      drawnAt,
    });
    const response = await request(app.getHttpServer())
      .get(`/api/v1/raffles/${entity.id}`)
      .expect(200);
    expect(response.body.winningNumber).toBe(7);
    expect(response.body.drawnAt).toBe(drawnAt.toISOString());
    expect(response.body).not.toHaveProperty("drawnByAdminId");
    expect(JSON.stringify(response.body)).not.toContain("buyer");
  });

  it.each(["draft", "unknown"])(
    "returns the same RAFFLE_NOT_FOUND contract for %s detail",
    async (scenario) => {
      const id =
        scenario === "draft"
          ? (await raffle(RaffleStatus.DRAFT)).id
          : crypto.randomUUID();
      const response = await request(app.getHttpServer())
        .get(`/api/v1/raffles/${id}`)
        .expect(404);
      expect(response.body.code).toBe("RAFFLE_NOT_FOUND");
    },
  );

  it.each(["draft", "unknown"])(
    "does not expose the number grid for a %s raffle",
    async (scenario) => {
      const id =
        scenario === "draft"
          ? (await raffle(RaffleStatus.DRAFT)).id
          : crypto.randomUUID();
      const response = await request(app.getHttpServer())
        .get(`/api/v1/raffles/${id}/numbers`)
        .expect(404);
      expect(response.body.code).toBe("RAFFLE_NOT_FOUND");
    },
  );

  it("returns 00-99 sorted, exact mixed stats and no PII despite real purchases/payments", async () => {
    const entity = await raffle(RaffleStatus.ACTIVE);
    const reserved = await attachPurchase(
      entity.id,
      37,
      RaffleNumberStatus.RESERVED,
    );
    const sold = await attachPurchase(entity.id, 38, RaffleNumberStatus.SOLD);

    const [numbersResponse, detailResponse, activeResponse] = await Promise.all([
      request(app.getHttpServer())
        .get(`/api/v1/raffles/${entity.id}/numbers`)
        .expect(200),
      request(app.getHttpServer())
        .get(`/api/v1/raffles/${entity.id}`)
        .expect(200),
      request(app.getHttpServer()).get("/api/v1/raffles/active").expect(200),
    ]);
    expect(numbersResponse.headers["cache-control"]).toContain("no-store");
    expect(numbersResponse.body.raffleId).toBe(entity.id);
    expect(numbersResponse.body.status).toBe(RaffleStatus.ACTIVE);
    expect(numbersResponse.body.numbers).toHaveLength(100);
    expect(numbersResponse.body.numbers.map((item: { number: number }) => item.number)).toEqual(
      Array.from({ length: 100 }, (_, number) => number),
    );
    expect(numbersResponse.body.numbers[0]).toEqual({
      number: 0,
      status: RaffleNumberStatus.AVAILABLE,
    });
    expect(numbersResponse.body.numbers[37]).toEqual({
      number: 37,
      status: RaffleNumberStatus.RESERVED,
    });
    expect(numbersResponse.body.numbers[38]).toEqual({
      number: 38,
      status: RaffleNumberStatus.SOLD,
    });
    expect(detailResponse.body.stats).toEqual({
      available: 98,
      reserved: 1,
      sold: 1,
      total: 100,
    });
    expect(activeResponse.body.stats).toEqual(detailResponse.body.stats);

    const publicJson = JSON.stringify({
      numbers: numbersResponse.body,
      detail: detailResponse.body,
      active: activeResponse.body,
    });
    for (const key of [
      "buyerName",
      "buyerEmail",
      "buyerPhone",
      "rafflePurchaseId",
      "orderId",
      "paymentId",
      "providerPaymentId",
      "reservedAt",
      "reservedUntil",
      "soldAt",
      "drawnByAdminId",
      "audit",
      "reviewReason",
    ])
      expect(publicJson).not.toContain(`\"${key}\"`);
    for (const secret of [
      "Persona Secreta",
      "pii-secret@example.test",
      "+54 249 555 0000",
      reserved.purchase.id,
      reserved.order.id,
      sold.purchase.id,
      sold.order.id,
      "provider-secret-",
    ])
      expect(publicJson).not.toContain(secret);
  });

  it("reflects a reservation made between two snapshot reads", async () => {
    const entity = await raffle(RaffleStatus.ACTIVE);
    const before = await request(app.getHttpServer())
      .get(`/api/v1/raffles/${entity.id}/numbers`)
      .expect(200);
    expect(before.body.numbers[37].status).toBe(RaffleNumberStatus.AVAILABLE);

    await request(app.getHttpServer())
      .post(`/api/v1/raffles/${entity.id}/reservations`)
      .set("Idempotency-Key", crypto.randomUUID())
      .set("X-Forwarded-For", crypto.randomUUID())
      .send({
        numbers: [37],
        buyerName: "Comprador R6",
        buyerEmail: "r6@example.test",
        buyerPhone: "+54 249 1234567",
      })
      .expect(201);

    const after = await request(app.getHttpServer())
      .get(`/api/v1/raffles/${entity.id}/numbers`)
      .expect(200);
    expect(after.body.numbers[37].status).toBe(RaffleNumberStatus.RESERVED);
  });

  it("uses the general GET limit instead of the strict reservation limit", async () => {
    const entity = await raffle(RaffleStatus.ACTIVE);
    for (let attempt = 0; attempt < 25; attempt += 1)
      await request(app.getHttpServer())
        .get(`/api/v1/raffles/${entity.id}/numbers`)
        .set("X-Forwarded-For", "203.0.113.60")
        .expect(200);
  });
});
