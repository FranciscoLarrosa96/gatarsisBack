import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import request = require("supertest");
import { DataSource, In } from "typeorm";
import { AdminRole, AdminUser } from "../src/admin/entities/admin-user.entity";
import { AdminAuditLog } from "../src/admin/entities/admin-audit-log.entity";
import { AppModule } from "../src/app.module";
import { OneActiveRaffle1767312000000 } from "../src/database/migrations/1767312000000-OneActiveRaffle";
import { Order, OrderStatus } from "../src/orders/entities/order.entity";
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
  RefundOperation,
  RefundOperationStatus,
} from "../src/payments/entities/refund-operation.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "../src/raffles/entities/raffle-number.entity";
import { RafflePurchase } from "../src/raffles/entities/raffle-purchase.entity";
import { Raffle, RaffleStatus } from "../src/raffles/entities/raffle.entity";
import { RaffleDrawMethod } from "../src/raffles/raffles.dto";

describe("admin raffle lifecycle R5 (PostgreSQL)", () => {
  let app: INestApplication;
  let ds: DataSource;
  let payments: PaymentsService;
  let token: string;
  let adminId: string;
  const createPreference = jest.fn();
  const searchPayments = jest.fn();

  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.DATABASE_NAME ??= "gatarsis_test";
    process.env.MP_ENABLED = "true";
    process.env.MP_ACCESS_TOKEN = "test-token";
    process.env.MP_WEBHOOK_SECRET = "test-secret";
    process.env.FRONTEND_URL = "https://gatarsis.com.ar";
    process.env.MP_RECONCILIATION_GRACE_SECONDS = "0";
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MERCADO_PAGO_GATEWAY)
      .useValue({
        createPreference,
        searchPreferencesByExternalReference: jest.fn().mockResolvedValue([]),
        getPayment: jest.fn(),
        searchPaymentsByExternalReference: searchPayments,
        refundPayment: jest.fn(),
        listRefunds: jest.fn().mockResolvedValue([]),
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
    payments = app.get(PaymentsService);
    await ds.runMigrations();
  });

  afterAll(async () => app.close());

  beforeEach(async () => {
    await ds.query(
      "TRUNCATE raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, refund_operations, webhook_events, inventory_movements, payments, payment_preferences, order_fulfillments, order_items, orders, inventory, product_media, product_variants, products RESTART IDENTITY CASCADE",
    );
    createPreference.mockReset().mockResolvedValue({
      id: `preference-${crypto.randomUUID()}`,
      init_point: "https://mp.test/raffle",
    });
    searchPayments.mockReset().mockResolvedValue([]);
    const admin = await ds.getRepository(AdminUser).save({
      email: `${crypto.randomUUID()}@example.test`,
      passwordHash: await bcrypt.hash("CorrectHorseBatteryStaple!", 4),
      role: AdminRole.ADMIN,
      active: true,
      lastLoginAt: null,
    });
    adminId = admin.id;
    token = (
      await request(app.getHttpServer())
        .post("/api/v1/admin/auth/login")
        .set("X-Forwarded-For", crypto.randomUUID())
        .send({
          email: admin.email,
          password: "CorrectHorseBatteryStaple!",
        })
        .expect(200)
    ).body.accessToken;
  });

  async function create(title = `Rifa ${crypto.randomUUID()}`) {
    return (
      await request(app.getHttpServer())
        .post("/api/v1/admin/raffles")
        .set(auth())
        .send({
          title,
          prizeName: "Premio R5",
          description: "Rifa solidaria",
          imageUrl: "https://res.cloudinary.com/demo/image/upload/prize.jpg",
          priceInCents: 50_000,
          drawAt: "2027-01-31T20:00:00.000Z",
        })
        .expect(201)
    ).body as Raffle;
  }

  function action(id: string, name: string) {
    return request(app.getHttpServer())
      .post(`/api/v1/admin/raffles/${id}/${name}`)
      .set(auth());
  }

  async function active() {
    const raffle = await create();
    await action(raffle.id, "publish").expect(201);
    return ds.getRepository(Raffle).findOneByOrFail({ id: raffle.id });
  }

  async function reserve(raffleId: string, numbers: number[]) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/raffles/${raffleId}/reservations`)
      .set("Idempotency-Key", crypto.randomUUID())
      .set("X-Forwarded-For", crypto.randomUUID())
      .send({
        numbers,
        buyerName: `Buyer ${numbers.join("-")}`,
        buyerEmail: `${crypto.randomUUID()}@buyer.test`,
        buyerPhone: "+54 249 1234567",
      })
      .expect(201);
    return {
      purchase: await ds.getRepository(RafflePurchase).findOneByOrFail({
        id: response.body.rafflePurchaseId,
      }),
      order: await ds.getRepository(Order).findOneByOrFail({
        id: response.body.orderId,
      }),
    };
  }

  const approved = (order: Order): MercadoPagoPayment => ({
    id: `payment-${crypto.randomUUID()}`,
    status: "approved",
    transaction_amount: order.totalInCents / 100,
    currency_id: "ARS",
    external_reference: order.id,
  });

  async function settle(order: Order) {
    const remote = approved(order);
    await payments.recordAndApply(remote);
    return ds.getRepository(Payment).findOneByOrFail({
      providerPaymentId: remote.id,
    });
  }

  it("implements DRAFT -> ACTIVE -> PAUSED -> ACTIVE -> CLOSED with exact audit", async () => {
    const raffle = await create();
    await action(raffle.id, "publish").expect(201);
    await action(raffle.id, "pause").expect(201);
    await action(raffle.id, "resume").expect(201);
    await action(raffle.id, "close").expect(201);
    expect(
      await ds.getRepository(Raffle).findOneByOrFail({ id: raffle.id }),
    ).toMatchObject({ status: RaffleStatus.CLOSED });
    const audit = await ds.getRepository(AdminAuditLog).find({
      where: { entityId: raffle.id },
      order: { createdAt: "ASC" },
    });
    expect(audit.map((item) => item.action)).toEqual([
      "RAFFLE_CREATED",
      "RAFFLE_ACTIVATED",
      "RAFFLE_PAUSED",
      "RAFFLE_RESUMED",
      "RAFFLE_CLOSED",
    ]);
    expect(audit.slice(1).every((item) => item.adminUserId === adminId)).toBe(
      true,
    );
  });

  it("supports PAUSED -> CLOSED and rejects reservations after committed close", async () => {
    const raffle = await active();
    await action(raffle.id, "pause").expect(201);
    await action(raffle.id, "close").expect(201);
    const response = await request(app.getHttpServer())
      .post(`/api/v1/raffles/${raffle.id}/reservations`)
      .set("Idempotency-Key", crypto.randomUUID())
      .set("X-Forwarded-For", crypto.randomUUID())
      .send({
        numbers: [8],
        buyerName: "Blocked",
        buyerEmail: "closed@example.test",
        buyerPhone: "+54000",
      });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("RAFFLE_NOT_ACTIVE");
  });

  it("rejects illegal transitions and refuses publishing a corrupt grid", async () => {
    const draft = await create();
    expect((await action(draft.id, "close")).body.code).toBe(
      "RAFFLE_CLOSE_NOT_ALLOWED",
    );
    expect(
      (await action(draft.id, "draw").send({ winningNumber: 37 })).body.code,
    ).toBe("RAFFLE_DRAW_NOT_ALLOWED");
    await ds.getRepository(RaffleNumber).delete({
      raffleId: draft.id,
      number: 99,
    });
    expect((await action(draft.id, "publish")).body.code).toBe(
      "RAFFLE_PUBLISH_NOT_ALLOWED",
    );
    expect(
      await ds.getRepository(AdminAuditLog).countBy({
        entityId: draft.id,
        action: "RAFFLE_ACTIVATED",
      }),
    ).toBe(0);
  });

  it("allows only one concurrent publish and enforces it in PostgreSQL", async () => {
    const [first, second] = await Promise.all([
      create("Primera"),
      create("Segunda"),
    ]);
    const responses = await Promise.all([
      action(first.id, "publish").then((response) => response),
      action(second.id, "publish").then((response) => response),
    ]);
    expect(responses.map((item) => item.status).sort()).toEqual([201, 409]);
    expect(responses.find((item) => item.status === 409)?.body.code).toBe(
      "RAFFLE_ACTIVE_ALREADY_EXISTS",
    );
    expect(
      await ds.getRepository(Raffle).countBy({ status: RaffleStatus.ACTIVE }),
    ).toBe(1);
    const inactive = responses[0].status === 409 ? first : second;
    await expect(
      ds.getRepository(Raffle).update(inactive.id, {
        status: RaffleStatus.ACTIVE,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("allows only one concurrent resume", async () => {
    const [first, second] = await Promise.all([create(), create()]);
    await ds
      .getRepository(Raffle)
      .update({ id: first.id }, { status: RaffleStatus.PAUSED });
    await ds
      .getRepository(Raffle)
      .update({ id: second.id }, { status: RaffleStatus.PAUSED });
    const responses = await Promise.all([
      action(first.id, "resume").then((response) => response),
      action(second.id, "resume").then((response) => response),
    ]);
    expect(responses.map((item) => item.status).sort()).toEqual([201, 409]);
    expect(responses.find((item) => item.status === 409)?.body.code).toBe(
      "RAFFLE_ACTIVE_ALREADY_EXISTS",
    );
    expect(
      await ds.getRepository(Raffle).countBy({ status: RaffleStatus.ACTIVE }),
    ).toBe(1);
  });

  it("validates the single-ACTIVE migration DOWN and UP", async () => {
    const migration = new OneActiveRaffle1767312000000();
    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      await migration.down(runner);
      const [first, second] = await Promise.all([create(), create()]);
      await ds.getRepository(Raffle).update(first.id, {
        status: RaffleStatus.ACTIVE,
      });
      await ds.getRepository(Raffle).update(second.id, {
        status: RaffleStatus.ACTIVE,
      });
      expect(
        await ds.getRepository(Raffle).countBy({ status: RaffleStatus.ACTIVE }),
      ).toBe(2);
      await ds
        .getRepository(Raffle)
        .update(
          { id: In([first.id, second.id]) },
          { status: RaffleStatus.DRAFT },
        );
      await migration.up(runner);
      await ds.getRepository(Raffle).update(first.id, {
        status: RaffleStatus.ACTIVE,
      });
      await expect(
        ds.getRepository(Raffle).update(second.id, {
          status: RaffleStatus.ACTIVE,
        }),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      const indexes = await ds.query<{ exists: boolean }[]>(
        `SELECT to_regclass('"UQ_raffles_single_active"') IS NOT NULL AS exists`,
      );
      if (!indexes[0]?.exists) {
        await ds
          .getRepository(Raffle)
          .update(
            { status: RaffleStatus.ACTIVE },
            { status: RaffleStatus.DRAFT },
          );
        await migration.up(runner);
      }
      await runner.release();
    }
  });

  it("pause blocks new reservations but preserves preference and settlement of existing ones", async () => {
    const raffle = await active();
    const existing = await reserve(raffle.id, [7]);
    await action(raffle.id, "pause").expect(201);
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/raffles/${raffle.id}/reservations`)
          .set("Idempotency-Key", crypto.randomUUID())
          .set("X-Forwarded-For", crypto.randomUUID())
          .send({
            numbers: [8],
            buyerName: "Blocked",
            buyerEmail: "blocked@example.test",
            buyerPhone: "+54000",
          })
      ).body.code,
    ).toBe("RAFFLE_NOT_ACTIVE");
    await request(app.getHttpServer())
      .post(
        `/api/v1/raffle-purchases/${existing.purchase.id}/mercado-pago/preference`,
      )
      .expect(201);
    await settle(existing.order);
    expect(
      await ds.getRepository(RaffleNumber).findOneByOrFail({
        raffleId: raffle.id,
        number: 7,
      }),
    ).toMatchObject({ status: RaffleNumberStatus.SOLD });
  });

  it("close preserves existing payment lifecycle and expiration", async () => {
    const raffle = await active();
    const paid = await reserve(raffle.id, [10]);
    const expired = await reserve(raffle.id, [11]);
    await action(raffle.id, "close").expect(201);
    await settle(paid.order);
    await ds.getRepository(Order).update(expired.order.id, {
      reservationExpiresAt: new Date(Date.now() - 10_000),
    });
    searchPayments.mockResolvedValue([]);
    await payments.reconcileExpiredReservations();
    expect(
      await ds.getRepository(RaffleNumber).findOneByOrFail({
        raffleId: raffle.id,
        number: 10,
      }),
    ).toMatchObject({ status: RaffleNumberStatus.SOLD });
    expect(
      await ds.getRepository(RaffleNumber).findOneByOrFail({
        raffleId: raffle.id,
        number: 11,
      }),
    ).toMatchObject({ status: RaffleNumberStatus.AVAILABLE });
    expect(
      await ds.getRepository(Raffle).findOneByOrFail({ id: raffle.id }),
    ).toMatchObject({ status: RaffleStatus.CLOSED });
  });

  it("serializes close versus reservation without accepting one after committed close", async () => {
    const raffle = await active();
    const reservation = request(app.getHttpServer())
      .post(`/api/v1/raffles/${raffle.id}/reservations`)
      .set("Idempotency-Key", crypto.randomUUID())
      .set("X-Forwarded-For", crypto.randomUUID())
      .send({
        numbers: [20],
        buyerName: "Race Buyer",
        buyerEmail: "race@example.test",
        buyerPhone: "+54000",
      })
      .then((response) => response);
    const closing = action(raffle.id, "close").then((response) => response);
    const [reserveResponse, closeResponse] = await Promise.all([
      reservation,
      closing,
    ]);
    expect(closeResponse.status).toBe(201);
    expect([201, 409]).toContain(reserveResponse.status);
    if (reserveResponse.status === 409)
      expect(reserveResponse.body.code).toBe("RAFFLE_NOT_ACTIVE");
    else
      expect(
        await ds.getRepository(RaffleNumber).findOneByOrFail({
          raffleId: raffle.id,
          number: 20,
        }),
      ).toMatchObject({ status: RaffleNumberStatus.RESERVED });
  });

  it("draws only a SOLD number backed by a PAID order and is terminal", async () => {
    const raffle = await active();
    const fixture = await reserve(raffle.id, [37]);
    await settle(fixture.order);
    await action(raffle.id, "close").expect(201);
    const drawn = await action(raffle.id, "draw")
      .send({ winningNumber: 37 })
      .expect(201);
    expect(drawn.body).toMatchObject({
      status: RaffleStatus.DRAWN,
      winningNumber: 37,
      drawnByAdminId: adminId,
    });
    expect(drawn.body.drawnAt).toBeTruthy();
    expect(
      (await action(raffle.id, "draw").send({ winningNumber: 37 })).body.code,
    ).toBe("RAFFLE_ALREADY_DRAWN");
    expect((await action(raffle.id, "publish")).body.code).toBe(
      "RAFFLE_PUBLISH_NOT_ALLOWED",
    );
    expect(
      await ds.getRepository(AdminAuditLog).countBy({
        action: "RAFFLE_DRAWN",
        entityId: raffle.id,
        adminUserId: adminId,
      }),
    ).toBe(1);
  });

  it("rejects AVAILABLE, RESERVED, REFUNDED and out-of-range winners", async () => {
    const raffle = await active();
    const reserved = await reserve(raffle.id, [37]);
    const refunded = await reserve(raffle.id, [38]);
    await settle(refunded.order);
    await ds.getRepository(Order).update(refunded.order.id, {
      status: OrderStatus.REFUNDED,
    });
    await action(raffle.id, "close").expect(201);
    expect(
      (await action(raffle.id, "draw").send({ winningNumber: 39 })).body.code,
    ).toBe("RAFFLE_DRAW_NOT_ALLOWED");
    await ds.getRepository(Order).update(reserved.order.id, {
      status: OrderStatus.EXPIRED,
    });
    await ds.getRepository(RaffleNumber).update(
      { raffleId: raffle.id, number: 37 },
      {
        status: RaffleNumberStatus.AVAILABLE,
        rafflePurchaseId: null,
        reservedAt: null,
        reservedUntil: null,
      },
    );
    for (const number of [37, 38, 39])
      expect(
        (await action(raffle.id, "draw").send({ winningNumber: number })).body
          .code,
      ).toBe("RAFFLE_WINNING_NUMBER_NOT_ELIGIBLE");
    await action(raffle.id, "draw").send({ winningNumber: 100 }).expect(400);
  });

  it("allows exactly one concurrent draw", async () => {
    const raffle = await active();
    const fixture = await reserve(raffle.id, [37]);
    await settle(fixture.order);
    await action(raffle.id, "close").expect(201);
    const responses = await Promise.all([
      action(raffle.id, "draw")
        .send({ winningNumber: 37 })
        .then((response) => response),
      action(raffle.id, "draw")
        .send({ winningNumber: 37 })
        .then((response) => response),
    ]);
    expect(responses.map((item) => item.status).sort()).toEqual([201, 409]);
    expect(responses.find((item) => item.status === 409)?.body.code).toBe(
      "RAFFLE_ALREADY_DRAWN",
    );
    expect(
      await ds.getRepository(AdminAuditLog).countBy({
        action: "RAFFLE_DRAWN",
        entityId: raffle.id,
      }),
    ).toBe(1);
  });

  it("never draws a RESERVED winner during settlement versus draw", async () => {
    const raffle = await active();
    const fixture = await reserve(raffle.id, [37]);
    await action(raffle.id, "close").expect(201);
    const applying = payments.recordAndApply(approved(fixture.order));
    const drawing = action(raffle.id, "draw")
      .send({ winningNumber: 37 })
      .then((response) => response);
    const [, drawResponse] = await Promise.all([applying, drawing]);
    expect([201, 409]).toContain(drawResponse.status);
    if (drawResponse.status === 409)
      await action(raffle.id, "draw").send({ winningNumber: 37 }).expect(201);
    const winner = await ds.getRepository(RaffleNumber).findOneByOrFail({
      raffleId: raffle.id,
      number: 37,
    });
    expect(winner.status).toBe(RaffleNumberStatus.SOLD);
    expect(
      await ds.getRepository(Raffle).findOneByOrFail({ id: raffle.id }),
    ).toMatchObject({
      status: RaffleStatus.DRAWN,
      winningNumber: 37,
    });
  });

  it("returns exact dashboard, ordered grid, purchase list and investigative detail", async () => {
    const raffle = await active();
    const paid = await reserve(raffle.id, [1, 2]);
    const paidPayment = await settle(paid.order);
    const refunded = await reserve(raffle.id, [3]);
    const refundedPayment = await settle(refunded.order);
    await ds.getRepository(Order).update(refunded.order.id, {
      status: OrderStatus.REFUNDED,
    });
    const reservation = await reserve(raffle.id, [4]);
    await ds.getRepository(RefundOperation).save({
      paymentId: refundedPayment.id,
      orderId: refunded.order.id,
      adminUserId: adminId,
      idempotencyKey: crypto.randomUUID(),
      amountInCents: refunded.order.totalInCents,
      reason: "Test refund",
      status: RefundOperationStatus.SUCCEEDED,
      providerRefundId: "refund-r5",
      lastError: null,
      completedAt: new Date(),
    });

    const dashboard = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${raffle.id}`)
      .set(auth())
      .expect(200);
    expect(dashboard.body.stats).toEqual({
      totalNumbers: 100,
      available: 96,
      reserved: 1,
      sold: 3,
      paidPurchases: 1,
      activeReservations: 1,
      revenueInCents: 100_000,
    });
    expect(dashboard.body.history.length).toBeGreaterThanOrEqual(2);

    const grid = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${raffle.id}/numbers`)
      .set(auth())
      .expect(200);
    expect(grid.body).toHaveLength(100);
    expect(grid.body.map((item: { number: number }) => item.number)).toEqual(
      Array.from({ length: 100 }, (_, number) => number),
    );
    expect(grid.body[0]).toMatchObject({
      status: RaffleNumberStatus.AVAILABLE,
      buyer: null,
      order: null,
      payment: null,
    });
    expect(grid.body[1]).toEqual(
      expect.objectContaining({
        status: RaffleNumberStatus.SOLD,
        buyer: expect.objectContaining({ name: "Buyer 1-2" }),
        order: { id: paid.order.id, status: OrderStatus.PAID },
        payment: expect.objectContaining({
          id: paidPayment.id,
          processingStatus: PaymentProcessingStatus.APPLIED,
        }),
      }),
    );

    const list = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${raffle.id}/purchases?page=1&pageSize=2`)
      .set(auth())
      .expect(200);
    expect(list.body).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(list.body.items).toHaveLength(2);
    const all = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${raffle.id}/purchases?pageSize=20`)
      .set(auth())
      .expect(200);
    expect(
      new Set(all.body.items.map((item: { status: string }) => item.status)),
    ).toEqual(new Set(["PAID", "REFUNDED", "RESERVED"]));
    const reservedView = all.body.items.find(
      (item: { rafflePurchaseId: string }) =>
        item.rafflePurchaseId === reservation.purchase.id,
    );
    expect(reservedView).toEqual(
      expect.objectContaining({
        numbers: [4],
        unitPriceInCents: 50_000,
        totalInCents: 50_000,
        status: "RESERVED",
      }),
    );

    const detail = await request(app.getHttpServer())
      .get(
        `/api/v1/admin/raffles/${raffle.id}/purchases/${refunded.purchase.id}`,
      )
      .set(auth())
      .expect(200);
    expect(detail.body).toEqual(
      expect.objectContaining({
        rafflePurchaseId: refunded.purchase.id,
        status: "REFUNDED",
        numbers: [3],
        payment: expect.objectContaining({ id: refundedPayment.id }),
        refunds: [
          expect.objectContaining({
            status: RefundOperationStatus.SUCCEEDED,
            providerRefundId: "refund-r5",
          }),
        ],
      }),
    );
    expect(JSON.stringify(detail.body)).not.toContain("test-token");
    expect(JSON.stringify(detail.body)).not.toContain("test-secret");
  });

  it("derives PAYMENT_PENDING, REQUIRES_REVIEW and EXPIRED purchase statuses", async () => {
    const raffle = await active();
    const pending = await reserve(raffle.id, [50]);
    await payments.recordAndApply({
      ...approved(pending.order),
      status: "pending",
    });
    const review = await reserve(raffle.id, [51]);
    await payments.recordAndApply({
      ...approved(review.order),
      transaction_amount: 1,
    });
    const expired = await reserve(raffle.id, [52]);
    await ds.getRepository(Order).update(expired.order.id, {
      status: OrderStatus.EXPIRED,
    });
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${raffle.id}/purchases?pageSize=20`)
      .set(auth())
      .expect(200);
    expect(
      new Set(
        response.body.items.map((item: { status: string }) => item.status),
      ),
    ).toEqual(new Set(["PAYMENT_PENDING", "REQUIRES_REVIEW", "EXPIRED"]));
  });

  it("reports backend-owned draw readiness and privacy-safe eligible participants", async () => {
    const raffle = await active();
    const paid = await reserve(raffle.id, [7, 12]);
    await settle(paid.order);
    await action(raffle.id, "close").expect(201);

    const readiness = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${raffle.id}/draw-readiness`)
      .set(auth())
      .expect(200);
    expect(readiness.body).toMatchObject({
      canDraw: true,
      blockers: [],
      totalNumbers: 100,
      eligibleCount: 2,
      eligibleNumbers: [7, 12],
      revenueInCents: 100_000,
      participants: [
        { number: 7, buyerName: "Buyer 7-12" },
        { number: 12, buyerName: "Buyer 7-12" },
      ],
      result: null,
    });
    expect(JSON.stringify(readiness.body)).not.toContain("@buyer.test");
    expect(JSON.stringify(readiness.body)).not.toContain("+54 249");
  });

  it("reports pending blockers and refuses AUTOMATIC until reservations resolve", async () => {
    const raffle = await active();
    await reserve(raffle.id, [31]);
    await action(raffle.id, "close").expect(201);
    const readiness = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${raffle.id}/draw-readiness`)
      .set(auth())
      .expect(200);
    expect(readiness.body).toMatchObject({
      canDraw: false,
      eligibleCount: 0,
    });
    expect(readiness.body.blockers).toEqual(
      expect.arrayContaining([
        { code: "RAFFLE_RESERVED_NUMBERS_PENDING", count: 1 },
        { code: "RAFFLE_PAYMENTS_PENDING", count: 1 },
        { code: "RAFFLE_NO_ELIGIBLE_PARTICIPANTS" },
      ]),
    );
    expect(
      (
        await action(raffle.id, "draw")
          .send({ method: RaffleDrawMethod.AUTOMATIC })
          .expect(409)
      ).body.code,
    ).toBe("RAFFLE_DRAW_NOT_ALLOWED");
    expect(
      await ds.getRepository(AdminAuditLog).countBy({
        action: "RAFFLE_DRAWN",
        entityId: raffle.id,
      }),
    ).toBe(0);
  });

  it("draws AUTOMATIC on the existing endpoint and persists the backend-selected result", async () => {
    const raffle = await active();
    const paid = await reserve(raffle.id, [47]);
    await settle(paid.order);
    await action(raffle.id, "close").expect(201);

    const response = await action(raffle.id, "draw")
      .send({ method: RaffleDrawMethod.AUTOMATIC })
      .expect(201);
    expect(response.body).toMatchObject({
      status: RaffleStatus.DRAWN,
      winningNumber: 47,
      drawMethod: RaffleDrawMethod.AUTOMATIC,
      eligibleCount: 1,
      winner: { number: 47, buyerName: "Buyer 47" },
      drawnByAdminId: adminId,
    });
    const audit = await ds.getRepository(AdminAuditLog).findOneByOrFail({
      action: "RAFFLE_DRAWN",
      entityId: raffle.id,
    });
    expect(audit.metadata).toMatchObject({
      drawMethod: RaffleDrawMethod.AUTOMATIC,
      winningNumber: 47,
      eligibleCount: 1,
      eligibleNumbers: [47],
    });
    expect(audit.metadata).not.toHaveProperty("note");

    await ds.getRepository(Order).update(paid.order.id, {
      status: OrderStatus.REFUNDED,
    });
    const reloaded = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${raffle.id}/draw-readiness`)
      .set(auth())
      .expect(200);
    expect(reloaded.body).toMatchObject({
      canDraw: false,
      result: {
        winningNumber: 47,
        drawMethod: RaffleDrawMethod.AUTOMATIC,
        buyerName: "Buyer 47",
      },
    });
    expect(reloaded.body.blockers).toContainEqual({
      code: "RAFFLE_ALREADY_DRAWN",
    });
  });

  it("registers EXTERNAL on the same endpoint with an eligible number and audited note", async () => {
    const raffle = await active();
    const paid = await reserve(raffle.id, [21, 47]);
    await settle(paid.order);
    await action(raffle.id, "close").expect(201);

    const response = await action(raffle.id, "draw")
      .send({
        method: RaffleDrawMethod.EXTERNAL,
        winningNumber: 47,
        note: "Sorteo realizado mediante Instagram Live",
      })
      .expect(201);
    expect(response.body).toMatchObject({
      status: RaffleStatus.DRAWN,
      winningNumber: 47,
      drawMethod: RaffleDrawMethod.EXTERNAL,
      eligibleCount: 2,
      winner: { number: 47, buyerName: "Buyer 21-47" },
    });
    expect(
      (
        await ds.getRepository(AdminAuditLog).findOneByOrFail({
          action: "RAFFLE_DRAWN",
          entityId: raffle.id,
        })
      ).metadata,
    ).toMatchObject({
      drawMethod: RaffleDrawMethod.EXTERNAL,
      winningNumber: 47,
      eligibleCount: 2,
      eligibleNumbers: [21, 47],
      note: "Sorteo realizado mediante Instagram Live",
    });
  });

  it("rejects winner injection into AUTOMATIC and exposes no /sortear backend bypass", async () => {
    const raffle = await active();
    await action(raffle.id, "close").expect(201);
    expect(
      (
        await action(raffle.id, "draw")
          .send({ method: RaffleDrawMethod.AUTOMATIC, winningNumber: 47 })
          .expect(400)
      ).body.code,
    ).toBe("RAFFLE_DRAW_PAYLOAD_INVALID");
    await request(app.getHttpServer())
      .post(`/api/v1/sortear/${raffle.id}`)
      .send({ winningNumber: 47 })
      .expect(404);
  });

  it("allows exactly one concurrent AUTOMATIC draw and keeps one immutable audit", async () => {
    const raffle = await active();
    const paid = await reserve(raffle.id, [47]);
    await settle(paid.order);
    await action(raffle.id, "close").expect(201);
    const responses = await Promise.all([
      action(raffle.id, "draw")
        .send({ method: RaffleDrawMethod.AUTOMATIC })
        .then((response) => response),
      action(raffle.id, "draw")
        .send({ method: RaffleDrawMethod.AUTOMATIC })
        .then((response) => response),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      responses.find((response) => response.status === 409)?.body.code,
    ).toBe("RAFFLE_ALREADY_DRAWN");
    expect(
      await ds.getRepository(AdminAuditLog).countBy({
        action: "RAFFLE_DRAWN",
        entityId: raffle.id,
      }),
    ).toBe(1);
  });

  it("protects automatic draw and readiness with the existing Admin authentication", async () => {
    const raffleId = crypto.randomUUID();
    await request(app.getHttpServer())
      .post(`/api/v1/admin/raffles/${raffleId}/draw`)
      .send({ method: RaffleDrawMethod.AUTOMATIC })
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${raffleId}/draw-readiness`)
      .expect(401);
  });

  it.each([
    ["post", "publish"],
    ["post", "pause"],
    ["post", "resume"],
    ["post", "close"],
    ["post", "draw"],
    ["get", "numbers"],
    ["get", "purchases"],
  ])(
    "protects %s lifecycle/read action %s with Admin auth",
    async (method, suffix) => {
      const raffleId = crypto.randomUUID();
      const call =
        method === "get"
          ? request(app.getHttpServer()).get(
              `/api/v1/admin/raffles/${raffleId}/${suffix}`,
            )
          : request(app.getHttpServer()).post(
              `/api/v1/admin/raffles/${raffleId}/${suffix}`,
            );
      await call.expect(401);
    },
  );
});
