import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request = require("supertest");
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { Inventory } from "../src/inventory/entities/inventory.entity";
import { InventoryMovement } from "../src/inventory/entities/inventory-movement.entity";
import { OrderFulfillment } from "../src/orders/entities/order-fulfillment.entity";
import { OrderItem } from "../src/orders/entities/order-item.entity";
import {
  Order,
  OrderKind,
  OrderStatus,
} from "../src/orders/entities/order.entity";
import { OrdersService } from "../src/orders/orders.service";
import { ProductVariant } from "../src/products/entities/product-variant.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "../src/raffles/entities/raffle-number.entity";
import { RafflePurchase } from "../src/raffles/entities/raffle-purchase.entity";
import { Raffle, RaffleStatus } from "../src/raffles/entities/raffle.entity";

describe("public raffle reservations R3 (PostgreSQL)", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let ordersService: OrdersService;

  beforeAll(async () => {
    process.env.DATABASE_NAME ??= "gatarsis_test";
    process.env.MP_ENABLED = "false";
    process.env.RAFFLE_RESERVATION_MINUTES = "10";
    process.env.MAX_RAFFLE_NUMBERS_PER_PURCHASE = "10";
    process.env.MAX_ACTIVE_RAFFLE_RESERVATIONS_PER_EMAIL = "2";
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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
    dataSource = app.get(DataSource);
    ordersService = app.get(OrdersService);
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      "TRUNCATE raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, refund_operations, inventory_movements, payments, payment_preferences, order_fulfillments, order_items, orders, inventory, product_media, product_variants, products RESTART IDENTITY CASCADE",
    );
  });

  async function raffle(status = RaffleStatus.ACTIVE, priceInCents = 50_000) {
    return dataSource.transaction(async (manager) => {
      const created = await manager.save(Raffle, {
        title: "Rifa solidaria",
        prizeName: "Premio",
        description: null,
        imageUrls: [],
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

  const body = (numbers: unknown, overrides: Record<string, unknown> = {}) => ({
    numbers,
    buyerName: " Test Buyer ",
    buyerEmail: " Buyer@Example.COM ",
    buyerPhone: " +54 249 1234567 ",
    ...overrides,
  });

  function reserve(
    raffleId: string,
    numbers: unknown,
    key: string = crypto.randomUUID(),
    overrides: Record<string, unknown> = {},
    origin: string = crypto.randomUUID(),
  ) {
    return request(app.getHttpServer())
      .post(`/api/v1/raffles/${raffleId}/reservations`)
      .set("Idempotency-Key", key)
      .set("X-Forwarded-For", origin)
      .send(body(numbers, overrides));
  }

  it.each([
    [undefined, "RAFFLE_NUMBER_INVALID"],
    [[], "RAFFLE_NUMBER_INVALID"],
    [[-1], "RAFFLE_NUMBER_INVALID"],
    [[100], "RAFFLE_NUMBER_INVALID"],
    [[7.5], "RAFFLE_NUMBER_INVALID"],
    [["7"], "RAFFLE_NUMBER_INVALID"],
    [[7, 7], "RAFFLE_NUMBER_INVALID"],
    [
      Array.from({ length: 11 }, (_, index) => index),
      "RAFFLE_TOO_MANY_NUMBERS",
    ],
  ])("rejects invalid number selection %# with %s", async (numbers, code) => {
    const active = await raffle();
    const response = await reserve(active.id, numbers).expect(400);
    expect(response.body.code).toBe(code);
    expect(await dataSource.getRepository(Order).count()).toBe(0);
  });

  it("requires Idempotency-Key", async () => {
    const active = await raffle();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/raffles/${active.id}/reservations`)
      .set("X-Forwarded-For", crypto.randomUUID())
      .send(body([7]))
      .expect(400);
    expect(response.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("rejects an invalid buyer email", async () => {
    const active = await raffle();
    await reserve(active.id, [7], undefined, {
      buyerEmail: "not-an-email",
    }).expect(400);
  });

  it.each([
    RaffleStatus.DRAFT,
    RaffleStatus.PAUSED,
    RaffleStatus.CLOSED,
    RaffleStatus.DRAWN,
  ])("rejects raffle status %s", async (status) => {
    const inactive = await raffle(status);
    const response = await reserve(inactive.id, [7]).expect(409);
    expect(response.body.code).toBe("RAFFLE_NOT_ACTIVE");
  });

  it("returns RAFFLE_NOT_FOUND for an unknown raffle", async () => {
    const response = await reserve(crypto.randomUUID(), [7]).expect(404);
    expect(response.body.code).toBe("RAFFLE_NOT_FOUND");
  });

  it("creates a normalized multi-number reservation with server prices and no merch side effects", async () => {
    const active = await raffle(RaffleStatus.ACTIVE, 75_000);
    const response = await reserve(active.id, [65, 7, 23]).expect(201);
    expect(response.body).toMatchObject({
      raffleId: active.id,
      numbers: [7, 23, 65],
      unitPriceInCents: 75_000,
      totalInCents: 225_000,
    });
    expect(response.body).not.toHaveProperty("buyerName");
    expect(response.body).not.toHaveProperty("buyerEmail");
    expect(response.body).not.toHaveProperty("buyerPhone");
    const order = await dataSource.getRepository(Order).findOneByOrFail({
      id: response.body.orderId,
    });
    expect(order).toMatchObject({
      kind: OrderKind.RAFFLE,
      status: OrderStatus.AWAITING_PAYMENT,
      subtotalInCents: 225_000,
      totalInCents: 225_000,
    });
    const purchase = await dataSource
      .getRepository(RafflePurchase)
      .findOneByOrFail({ id: response.body.rafflePurchaseId });
    expect(purchase).toMatchObject({
      raffleId: active.id,
      orderId: order.id,
      buyerName: "Test Buyer",
      buyerEmail: "buyer@example.com",
      buyerPhone: "+54 249 1234567",
      unitPriceInCents: 75_000,
    });
    const numbers = await dataSource.getRepository(RaffleNumber).find({
      where: { rafflePurchaseId: purchase.id },
      order: { number: "ASC" },
    });
    expect(numbers.map((number) => number.number)).toEqual([7, 23, 65]);
    expect(
      numbers.every(
        (number) =>
          number.status === RaffleNumberStatus.RESERVED &&
          number.reservedAt !== null &&
          number.soldAt === null &&
          number.reservedUntil?.getTime() ===
            order.reservationExpiresAt.getTime(),
      ),
    ).toBe(true);
    expect(new Date(response.body.reservationExpiresAt).getTime()).toBe(
      order.reservationExpiresAt.getTime(),
    );
    expect(await dataSource.getRepository(OrderItem).count()).toBe(0);
    expect(await dataSource.getRepository(OrderFulfillment).count()).toBe(0);
    expect(await dataSource.getRepository(ProductVariant).count()).toBe(0);
    expect(await dataSource.getRepository(Inventory).count()).toBe(0);
    expect(await dataSource.getRepository(InventoryMovement).count()).toBe(0);
  });

  it("is all-or-nothing and reports every unavailable requested number sorted", async () => {
    const active = await raffle();
    await reserve(active.id, [65, 23], "owner", {
      buyerEmail: "owner@example.test",
    }).expect(201);
    const response = await reserve(active.id, [65, 7, 23], "challenger", {
      buyerEmail: "challenger@example.test",
    }).expect(409);
    expect(response.body).toMatchObject({
      code: "RAFFLE_NUMBER_UNAVAILABLE",
      details: { numbers: [23, 65] },
    });
    expect(
      await dataSource.getRepository(Order).countBy({
        idempotencyKey: "challenger",
      }),
    ).toBe(0);
    expect(
      await dataSource.getRepository(RafflePurchase).countBy({
        buyerEmail: "challenger@example.test",
      }),
    ).toBe(0);
    expect(
      await dataSource.getRepository(RaffleNumber).findOneByOrFail({
        raffleId: active.id,
        number: 7,
      }),
    ).toMatchObject({
      status: RaffleNumberStatus.AVAILABLE,
      rafflePurchaseId: null,
    });
  });

  it("reuses one reservation for the same key and normalized payload order", async () => {
    const active = await raffle();
    const key = "same-reservation";
    const [first, concurrent] = await Promise.all([
      reserve(active.id, [65, 7, 23], key),
      reserve(active.id, [7, 23, 65], key),
    ]);
    expect([first.status, concurrent.status]).toEqual([201, 201]);
    expect(first.body).toEqual(concurrent.body);
    expect(await dataSource.getRepository(Order).count()).toBe(1);
    expect(await dataSource.getRepository(RafflePurchase).count()).toBe(1);
    expect(
      await dataSource.getRepository(RaffleNumber).countBy({
        status: RaffleNumberStatus.RESERVED,
      }),
    ).toBe(3);
  });

  it("rejects reuse of an idempotency key with a different payload", async () => {
    const active = await raffle();
    await reserve(active.id, [7], "conflicting-key").expect(201);
    const response = await reserve(active.id, [8], "conflicting-key").expect(
      409,
    );
    expect(response.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await dataSource.getRepository(Order).count()).toBe(1);
  });

  it("does not reuse an expired idempotency key", async () => {
    const active = await raffle();
    const first = await reserve(active.id, [7], "expired-key").expect(201);
    await dataSource.getRepository(Order).update(first.body.orderId, {
      reservationExpiresAt: new Date(Date.now() - 1_000),
    });
    expect(await ordersService.expireOrder(first.body.orderId)).toBe(true);
    const response = await reserve(active.id, [7], "expired-key").expect(409);
    expect(response.body.code).toBe("RAFFLE_RESERVATION_EXPIRED");
    expect(await dataSource.getRepository(Order).count()).toBe(1);
  });

  it("allows exactly one of 20 concurrent buyers to reserve number 37", async () => {
    const active = await raffle();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        reserve(
          active.id,
          [37],
          `number-37-${index}`,
          { buyerEmail: `buyer-${index}@example.test` },
          `198.51.100.${index + 1}`,
        ),
      ),
    );
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(1);
    expect(
      responses.filter(
        (response) =>
          response.status === 409 &&
          response.body.code === "RAFFLE_NUMBER_UNAVAILABLE",
      ),
    ).toHaveLength(19);
    expect(
      responses.filter((response) => response.status === 500),
    ).toHaveLength(0);
    const number = await dataSource
      .getRepository(RaffleNumber)
      .findOneByOrFail({
        raffleId: active.id,
        number: 37,
      });
    expect(number.status).toBe(RaffleNumberStatus.RESERVED);
    expect(number.rafflePurchaseId).not.toBeNull();
    expect(await dataSource.getRepository(RafflePurchase).count()).toBe(1);
    expect(
      await dataSource.getRepository(Order).countBy({ kind: OrderKind.RAFFLE }),
    ).toBe(1);
  });

  it("serializes overlapping sets without deadlock or partial reservation", async () => {
    const active = await raffle();
    const responses = await Promise.all([
      reserve(active.id, [10, 20, 30], "overlap-a", {
        buyerEmail: "a@example.test",
      }),
      reserve(active.id, [20, 30, 40], "overlap-b", {
        buyerEmail: "b@example.test",
      }),
    ]);
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(1);
    expect(
      responses.filter(
        (response) =>
          response.status === 409 &&
          response.body.code === "RAFFLE_NUMBER_UNAVAILABLE",
      ),
    ).toHaveLength(1);
    expect(await dataSource.getRepository(RafflePurchase).count()).toBe(1);
    expect(
      await dataSource.getRepository(RaffleNumber).countBy({
        status: RaffleNumberStatus.RESERVED,
      }),
    ).toBe(3);
  });

  it("enforces two active reservations per normalized email", async () => {
    const active = await raffle();
    await reserve(active.id, [1], "cap-one", {
      buyerEmail: " Same@Example.TEST ",
    }).expect(201);
    await reserve(active.id, [2], "cap-two", {
      buyerEmail: "same@example.test",
    }).expect(201);
    const third = await reserve(active.id, [3], "cap-three", {
      buyerEmail: "SAME@example.test",
    }).expect(409);
    expect(third.body.code).toBe("ACTIVE_RESERVATION_LIMIT");
    expect(await dataSource.getRepository(RafflePurchase).count()).toBe(2);
  });

  it("serializes concurrent active-reservation limits by raffle and email", async () => {
    const active = await raffle();
    const responses = await Promise.all(
      [10, 11, 12].map((number) =>
        reserve(active.id, [number], `cap-concurrent-${number}`, {
          buyerEmail: "concurrent-cap@example.test",
        }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(2);
    expect(
      responses.filter(
        (response) =>
          response.status === 409 &&
          response.body.code === "ACTIVE_RESERVATION_LIMIT",
      ),
    ).toHaveLength(1);
    expect(await dataSource.getRepository(RafflePurchase).count()).toBe(2);
  });

  it("releases an expired reservation exactly once and keeps its history", async () => {
    const active = await raffle();
    const response = await reserve(active.id, [7, 23, 65]).expect(201);
    await dataSource.getRepository(Order).update(response.body.orderId, {
      reservationExpiresAt: new Date(Date.now() - 1_000),
    });
    expect(await ordersService.expireRaffleReservations()).toBe(1);
    expect(await ordersService.expireRaffleReservations()).toBe(0);
    expect(
      await dataSource.getRepository(Order).findOneByOrFail({
        id: response.body.orderId,
      }),
    ).toMatchObject({ status: OrderStatus.EXPIRED, kind: OrderKind.RAFFLE });
    expect(
      await dataSource.getRepository(RafflePurchase).countBy({
        id: response.body.rafflePurchaseId,
      }),
    ).toBe(1);
    const numbers = await dataSource.getRepository(RaffleNumber).find({
      where: { raffleId: active.id },
    });
    for (const number of numbers.filter((item) =>
      [7, 23, 65].includes(item.number),
    ))
      expect(number).toMatchObject({
        status: RaffleNumberStatus.AVAILABLE,
        rafflePurchaseId: null,
        reservedAt: null,
        reservedUntil: null,
        soldAt: null,
      });
  });

  it("does not release future PAYMENT_PENDING raffle orders in R3", async () => {
    const active = await raffle();
    const response = await reserve(active.id, [37]).expect(201);
    await dataSource.getRepository(Order).update(response.body.orderId, {
      status: OrderStatus.PAYMENT_PENDING,
      reservationExpiresAt: new Date(Date.now() - 1_000),
    });
    expect(await ordersService.expireRaffleReservations()).toBe(0);
    expect(
      await dataSource.getRepository(RaffleNumber).findOneByOrFail({
        raffleId: active.id,
        number: 37,
      }),
    ).toMatchObject({
      status: RaffleNumberStatus.RESERVED,
      rafflePurchaseId: response.body.rafflePurchaseId,
    });
  });

  it("defers RAFFLE expiry to payment reconciliation when Mercado Pago is enabled", async () => {
    const active = await raffle();
    const response = await reserve(active.id, [42]).expect(201);
    await dataSource.getRepository(Order).update(response.body.orderId, {
      reservationExpiresAt: new Date(Date.now() - 1_000),
    });
    const previous = {
      enabled: process.env.MP_ENABLED,
      token: process.env.MP_ACCESS_TOKEN,
      secret: process.env.MP_WEBHOOK_SECRET,
      frontend: process.env.FRONTEND_URL,
    };
    try {
      process.env.MP_ENABLED = "true";
      process.env.MP_ACCESS_TOKEN = "test-token";
      process.env.MP_WEBHOOK_SECRET = "test-secret";
      process.env.FRONTEND_URL = "https://gatarsis.com.ar";
      await ordersService.scheduledExpiration();
    } finally {
      for (const [name, value] of Object.entries({
        MP_ENABLED: previous.enabled,
        MP_ACCESS_TOKEN: previous.token,
        MP_WEBHOOK_SECRET: previous.secret,
        FRONTEND_URL: previous.frontend,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(
      await dataSource.getRepository(Order).findOneByOrFail({
        id: response.body.orderId,
      }),
    ).toMatchObject({ status: OrderStatus.AWAITING_PAYMENT });
    expect(
      await dataSource.getRepository(RaffleNumber).findOneByOrFail({
        raffleId: active.id,
        number: 42,
      }),
    ).toMatchObject({
      status: RaffleNumberStatus.RESERVED,
      rafflePurchaseId: response.body.rafflePurchaseId,
    });
  });

  it("keeps one owner during a race between expiry and a new reservation", async () => {
    const active = await raffle();
    const first = await reserve(active.id, [37], "race-owner", {
      buyerEmail: "owner@example.test",
    }).expect(201);
    await dataSource.getRepository(Order).update(first.body.orderId, {
      reservationExpiresAt: new Date(Date.now() - 1_000),
    });
    const [, challenger] = await Promise.all([
      ordersService.expireOrder(first.body.orderId),
      reserve(active.id, [37], "race-challenger", {
        buyerEmail: "challenger@example.test",
      }),
    ]);
    expect([201, 409]).toContain(challenger.status);
    const original = await dataSource.getRepository(Order).findOneByOrFail({
      id: first.body.orderId,
    });
    expect(original.status).toBe(OrderStatus.EXPIRED);
    const number = await dataSource
      .getRepository(RaffleNumber)
      .findOneByOrFail({
        raffleId: active.id,
        number: 37,
      });
    if (challenger.status === 201) {
      expect(number).toMatchObject({
        status: RaffleNumberStatus.RESERVED,
        rafflePurchaseId: challenger.body.rafflePurchaseId,
      });
      expect(await dataSource.getRepository(RafflePurchase).count()).toBe(2);
    } else {
      expect(number).toMatchObject({
        status: RaffleNumberStatus.AVAILABLE,
        rafflePurchaseId: null,
      });
      expect(await dataSource.getRepository(RafflePurchase).count()).toBe(1);
    }
  });

  it("rate-limits only the raffle reservation route to 20 requests per origin", async () => {
    const active = await raffle();
    const origin = "203.0.113.240";
    for (let index = 0; index < 20; index++)
      await reserve(
        active.id,
        [index],
        `rate-${index}`,
        { buyerEmail: `rate-${index}@example.test` },
        origin,
      ).expect(201);
    await reserve(
      active.id,
      [21],
      "rate-blocked",
      { buyerEmail: "rate-blocked@example.test" },
      origin,
    ).expect(429);
    await request(app.getHttpServer())
      .get("/api/v1/products")
      .set("X-Forwarded-For", origin)
      .expect(200);
  });
});
