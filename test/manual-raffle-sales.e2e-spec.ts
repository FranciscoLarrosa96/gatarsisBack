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
  OrderPaymentSource,
  OrderStatus,
} from "../src/orders/entities/order.entity";
import { Payment } from "../src/payments/entities/payment.entity";
import { PaymentPreference } from "../src/payments/entities/payment-preference.entity";
import { MERCADO_PAGO_GATEWAY } from "../src/payments/mercado-pago.gateway";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "../src/raffles/entities/raffle-number.entity";
import {
  ManualRafflePaymentMethod,
  RafflePurchase,
} from "../src/raffles/entities/raffle-purchase.entity";
import { Raffle, RaffleStatus } from "../src/raffles/entities/raffle.entity";

describe("admin manual raffle sales (PostgreSQL)", () => {
  let app: INestApplication;
  let ds: DataSource;
  let token: string;
  const gateway = {
    createPreference: jest.fn(),
    searchPreferencesByExternalReference: jest.fn(),
    getPayment: jest.fn(),
    searchPaymentsByExternalReference: jest.fn(),
    refundPayment: jest.fn(),
    listRefunds: jest.fn(),
    validateWebhookSignature: jest.fn(),
  };
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.DATABASE_NAME ??= "gatarsis_test";
    process.env.MP_ENABLED = "false";
    process.env.MAX_RAFFLE_NUMBERS_PER_PURCHASE = "10";
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MERCADO_PAGO_GATEWAY)
      .useValue(gateway)
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

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await ds.query(
      "TRUNCATE adoptable_cats, raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, refund_operations, inventory_movements, payments, payment_preferences, order_fulfillments, order_items, orders, inventory, product_media, product_variants, products RESTART IDENTITY CASCADE",
    );
    const admin = await ds.getRepository(AdminUser).save({
      email: `manual-${crypto.randomUUID()}@example.test`,
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

  async function raffle(
    status = RaffleStatus.ACTIVE,
    priceInCents = 10_000,
  ) {
    return ds.transaction(async (manager) => {
      const created = await manager.save(Raffle, {
        title: "Rifa manual",
        prizeName: "Premio",
        description: null,
        imageUrl: null,
        priceInCents,
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

  const payload = (
    numbers: number[],
    overrides: Record<string, unknown> = {},
  ) => ({
    numbers,
    buyer: {
      name: " Juan Pérez ",
      email: " JUAN@EXAMPLE.TEST ",
      whatsapp: " +54 249 1234567 ",
    },
    paymentMethod: ManualRafflePaymentMethod.TRANSFER,
    note: " Transferencia recibida ",
    idempotencyKey: `manual-${crypto.randomUUID()}`,
    ...overrides,
  });

  function sell(raffleId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/v1/admin/raffles/${raffleId}/manual-sales`)
      .set(auth())
      .send(body);
  }

  it("sells one available number with a real PAID/MANUAL order and safe audit", async () => {
    const active = await raffle();
    const response = await sell(active.id, payload([12])).expect(201);
    const order = await ds.getRepository(Order).findOneByOrFail({
      id: response.body.orderId,
    });
    const number = await ds.getRepository(RaffleNumber).findOneByOrFail({
      raffleId: active.id,
      number: 12,
    });
    expect(order).toMatchObject({
      kind: OrderKind.RAFFLE,
      status: OrderStatus.PAID,
      paymentSource: OrderPaymentSource.MANUAL,
      totalInCents: 10_000,
    });
    expect(number).toMatchObject({
      status: RaffleNumberStatus.SOLD,
      rafflePurchaseId: response.body.rafflePurchaseId,
    });
    expect(number.soldAt).not.toBeNull();
    const audit = await ds.getRepository(AdminAuditLog).findOneByOrFail({
      action: "manual_raffle_sale_created",
      entityId: active.id,
    });
    expect(audit.metadata).toMatchObject({
      numbers: [12],
      amountInCents: 10_000,
      paymentMethod: ManualRafflePaymentMethod.TRANSFER,
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("juan@example.test");
  });

  it("sells several numbers atomically using the raffle's current price", async () => {
    const active = await raffle(RaffleStatus.ACTIVE, 25_000);
    const response = await sell(active.id, payload([37, 12, 8])).expect(201);
    expect(response.body).toMatchObject({
      numbers: [8, 12, 37],
      unitPriceInCents: 25_000,
      totalInCents: 75_000,
    });
    expect(
      await ds.getRepository(RaffleNumber).countBy({
        raffleId: active.id,
        status: RaffleNumberStatus.SOLD,
      }),
    ).toBe(3);
  });

  it("rolls back the complete sale if any requested number is unavailable", async () => {
    const active = await raffle();
    await ds.getRepository(RaffleNumber).update(
      { raffleId: active.id, number: 12 },
      {
        status: RaffleNumberStatus.RESERVED,
        reservedAt: new Date(),
        reservedUntil: new Date(Date.now() + 60_000),
      },
    );
    const response = await sell(active.id, payload([12, 37])).expect(409);
    expect(response.body.code).toBe("RAFFLE_NUMBER_UNAVAILABLE");
    expect(
      await ds.getRepository(RaffleNumber).findOneByOrFail({
        raffleId: active.id,
        number: 37,
      }),
    ).toMatchObject({ status: RaffleNumberStatus.AVAILABLE });
    expect(await ds.getRepository(Order).count()).toBe(0);
  });

  it("rejects a manual sale when the raffle is closed", async () => {
    const closed = await raffle(RaffleStatus.CLOSED);
    const response = await sell(closed.id, payload([12])).expect(409);
    expect(response.body.code).toBe("RAFFLE_NOT_ACTIVE");
    expect(await ds.getRepository(Order).count()).toBe(0);
  });

  it("is idempotent and rejects reuse of the key with another payload", async () => {
    const active = await raffle();
    const body = payload([12], { idempotencyKey: "manual-stable-key" });
    const first = await sell(active.id, body).expect(201);
    const repeated = await sell(active.id, body).expect(201);
    expect(repeated.body.orderId).toBe(first.body.orderId);
    expect(repeated.body.rafflePurchaseId).toBe(first.body.rafflePurchaseId);
    expect(await ds.getRepository(Order).count()).toBe(1);
    expect(await ds.getRepository(RafflePurchase).count()).toBe(1);
    expect(
      await ds.getRepository(AdminAuditLog).countBy({
        action: "manual_raffle_sale_created",
      }),
    ).toBe(1);
    const conflict = await sell(
      active.id,
      payload([13], { idempotencyKey: "manual-stable-key" }),
    ).expect(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("allows exactly one winner against a concurrent public reservation", async () => {
    const active = await raffle();
    const [manual, publicReservation] = await Promise.all([
      sell(active.id, payload([12], { idempotencyKey: "manual-race-key" })),
      request(app.getHttpServer())
        .post(`/api/v1/raffles/${active.id}/reservations`)
        .set("Idempotency-Key", "public-race-key")
        .set("X-Forwarded-For", crypto.randomUUID())
        .send({
          numbers: [12],
          buyerName: "Web Buyer",
          buyerEmail: "web@example.test",
          buyerPhone: "+54 249 5555555",
        }),
    ]);
    expect([manual.status, publicReservation.status].sort()).toEqual([201, 409]);
    expect(await ds.getRepository(Order).count()).toBe(1);
    expect(await ds.getRepository(RafflePurchase).count()).toBe(1);
    const number = await ds.getRepository(RaffleNumber).findOneByOrFail({
      raffleId: active.id,
      number: 12,
    });
    expect([
      RaffleNumberStatus.RESERVED,
      RaffleNumberStatus.SOLD,
    ]).toContain(number.status);
  });

  it("includes manual sales in sold, available and revenue statistics", async () => {
    const active = await raffle(RaffleStatus.ACTIVE, 12_500);
    await sell(active.id, payload([1, 2])).expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${active.id}`)
      .set(auth())
      .expect(200);
    expect(detail.body.stats).toMatchObject({
      sold: 2,
      available: 98,
      revenueInCents: 25_000,
      paidPurchases: 1,
    });
  });

  it("does not create a Mercado Pago Payment/Preference or call its gateway", async () => {
    const active = await raffle();
    await sell(active.id, payload([12])).expect(201);
    expect(await ds.getRepository(Payment).count()).toBe(0);
    expect(await ds.getRepository(PaymentPreference).count()).toBe(0);
    for (const method of Object.values(gateway)) expect(method).not.toHaveBeenCalled();
  });

  it("shows manual origin, method, contact and note in raffle purchase detail", async () => {
    const active = await raffle();
    const sale = await sell(active.id, payload([12])).expect(201);
    const detail = await request(app.getHttpServer())
      .get(
        `/api/v1/admin/raffles/${active.id}/purchases/${sale.body.rafflePurchaseId}`,
      )
      .set(auth())
      .expect(200);
    expect(detail.body).toMatchObject({
      paymentSource: OrderPaymentSource.MANUAL,
      manualPaymentMethod: ManualRafflePaymentMethod.TRANSFER,
      manualPaymentNote: "Transferencia recibida",
      buyerName: "Juan Pérez",
      buyerEmail: "juan@example.test",
      buyerPhone: "+54 249 1234567",
      payment: null,
      preference: null,
      refunds: [],
    });
  });

  it("shows the manual source in Admin Orders without pretending an MP payment exists", async () => {
    const active = await raffle();
    const sale = await sell(active.id, payload([12])).expect(201);
    const list = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders?orderId=${sale.body.orderId}`)
      .set(auth())
      .expect(200);
    expect(list.body.items[0]).toMatchObject({
      id: sale.body.orderId,
      kind: OrderKind.RAFFLE,
      status: OrderStatus.PAID,
      paymentSource: OrderPaymentSource.MANUAL,
    });
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${sale.body.orderId}`)
      .set(auth())
      .expect(200);
    expect(detail.body.order.paymentSource).toBe(OrderPaymentSource.MANUAL);
    expect(detail.body.payments).toEqual([]);
    expect(detail.body.paymentPreference).toBeNull();
    expect(detail.body.rafflePurchase).toMatchObject({
      manualPaymentMethod: ManualRafflePaymentMethod.TRANSFER,
      manualPaymentNote: "Transferencia recibida",
    });
  });
});
