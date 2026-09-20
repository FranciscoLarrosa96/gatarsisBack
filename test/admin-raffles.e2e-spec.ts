import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import request = require("supertest");
import { DataSource } from "typeorm";
import { AdminRole, AdminUser } from "../src/admin/entities/admin-user.entity";
import { AdminAuditLog } from "../src/admin/entities/admin-audit-log.entity";
import { AppModule } from "../src/app.module";
import {
  Order,
  OrderKind,
  OrderStatus,
} from "../src/orders/entities/order.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "../src/raffles/entities/raffle-number.entity";
import { RafflePurchase } from "../src/raffles/entities/raffle-purchase.entity";
import { Raffle, RaffleStatus } from "../src/raffles/entities/raffle.entity";

describe("admin raffle R2 foundation (PostgreSQL)", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const payload = (overrides: Record<string, unknown> = {}) => ({
    title: "Rifa solidaria",
    prizeName: "Air Fryer Zenith",
    description: "A beneficio del refugio",
    imageUrl: "https://res.cloudinary.com/gatarsis/image/upload/prize.jpg",
    priceInCents: 500_000,
    drawAt: "2027-01-31T20:00:00.000Z",
    ...overrides,
  });

  beforeAll(async () => {
    process.env.DATABASE_NAME ??= "gatarsis_test";
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
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      "TRUNCATE raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, refund_operations, inventory_movements, payments, payment_preferences, order_items, orders, inventory, product_media, product_variants, products RESTART IDENTITY CASCADE",
    );
    const admin = await dataSource.getRepository(AdminUser).save({
      email: `raffles-${crypto.randomUUID()}@example.test`,
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

  async function createRaffle(overrides: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post("/api/v1/admin/raffles")
      .set(auth())
      .send(payload(overrides))
      .expect(201);
  }

  async function createOrder() {
    const order = await dataSource.getRepository(Order).save({
      status: OrderStatus.AWAITING_PAYMENT,
      idempotencyKey: crypto.randomUUID(),
      requestFingerprint: null,
      subtotalInCents: 1_000,
      totalInCents: 1_000,
      reservationExpiresAt: new Date(Date.now() + 60_000),
      paidAt: null,
    });
    return dataSource.getRepository(Order).findOneByOrFail({ id: order.id });
  }

  it("defaults existing/new commerce orders to MERCH", async () => {
    const order = await createOrder();
    expect(order.kind).toBe(OrderKind.MERCH);
    const dbKind = await dataSource.query<{ kind: string }[]>(
      "SELECT kind FROM orders WHERE id = $1",
      [order.id],
    );
    expect(dbKind[0].kind).toBe("MERCH");
  });

  it("creates one DRAFT raffle and exactly AVAILABLE integers 0 through 99 atomically", async () => {
    const response = await createRaffle();
    expect(response.body).toMatchObject({
      status: RaffleStatus.DRAFT,
      winningNumber: null,
      drawnAt: null,
      drawnByAdminId: null,
    });
    const rows = await dataSource.getRepository(RaffleNumber).find({
      where: { raffleId: response.body.id },
      order: { number: "ASC" },
    });
    expect(rows).toHaveLength(100);
    expect(rows.map((row) => row.number)).toEqual(
      Array.from({ length: 100 }, (_, index) => index),
    );
    expect(new Set(rows.map((row) => row.number)).size).toBe(100);
    expect(
      rows.every(
        (row) =>
          row.status === RaffleNumberStatus.AVAILABLE &&
          row.rafflePurchaseId === null &&
          row.reservedAt === null &&
          row.reservedUntil === null &&
          row.soldAt === null,
      ),
    ).toBe(true);
    const audit = await dataSource
      .getRepository(AdminAuditLog)
      .findOneByOrFail({
        action: "RAFFLE_CREATED",
        entityId: response.body.id,
      });
    expect(audit.metadata).toEqual({ numberCount: 100 });
  });

  it("rolls back the raffle, all numbers and audit if one number insert fails", async () => {
    await dataSource.query(`
      CREATE FUNCTION fail_raffle_number_50() RETURNS trigger AS $$
      BEGIN
        IF NEW.number = 50 THEN RAISE EXCEPTION 'controlled raffle number failure'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await dataSource.query(`
      CREATE TRIGGER trg_fail_raffle_number_50
      BEFORE INSERT ON raffle_numbers
      FOR EACH ROW EXECUTE FUNCTION fail_raffle_number_50()
    `);
    try {
      await request(app.getHttpServer())
        .post("/api/v1/admin/raffles")
        .set(auth())
        .send(payload({ title: "Debe hacer rollback" }))
        .expect(500);
      expect(await dataSource.getRepository(Raffle).count()).toBe(0);
      expect(await dataSource.getRepository(RaffleNumber).count()).toBe(0);
      expect(
        await dataSource.getRepository(AdminAuditLog).countBy({
          action: "RAFFLE_CREATED",
        }),
      ).toBe(0);
    } finally {
      await dataSource.query(
        "DROP TRIGGER IF EXISTS trg_fail_raffle_number_50 ON raffle_numbers",
      );
      await dataSource.query(
        "DROP FUNCTION IF EXISTS fail_raffle_number_50() ",
      );
    }
  });

  it.each([-1, 100])(
    "rejects number %s at PostgreSQL constraint level",
    async (number) => {
      const raffleId = (await createRaffle()).body.id;
      await expect(
        dataSource.query(
          "INSERT INTO raffle_numbers (raffle_id, number) VALUES ($1, $2)",
          [raffleId, number],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    },
  );

  it("rejects duplicate raffle numbers at PostgreSQL constraint level", async () => {
    const raffleId = (await createRaffle()).body.id;
    await expect(
      dataSource.query(
        "INSERT INTO raffle_numbers (raffle_id, number) VALUES ($1, 37)",
        [raffleId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("enforces raffle-number and raffle-purchase foreign keys", async () => {
    const raffleId = (await createRaffle()).body.id;
    const order = await createOrder();
    await expect(
      dataSource.query(
        "INSERT INTO raffle_numbers (raffle_id, number) VALUES ($1, 1)",
        [crypto.randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      dataSource.getRepository(RafflePurchase).save({
        raffleId,
        orderId: crypto.randomUUID(),
        buyerName: "Buyer",
        buyerEmail: "buyer@example.test",
        buyerPhone: "+540000",
        unitPriceInCents: 1_000,
      }),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      dataSource.getRepository(RafflePurchase).save({
        raffleId: crypto.randomUUID(),
        orderId: order.id,
        buyerName: "Buyer",
        buyerEmail: "buyer@example.test",
        buyerPhone: "+540000",
        unitPriceInCents: 1_000,
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("enforces unique purchase order and positive database prices", async () => {
    const raffleId = (await createRaffle()).body.id;
    const order = await createOrder();
    await expect(
      dataSource.query(
        "INSERT INTO raffles (title, prize_name, price_in_cents) VALUES ('Invalid', 'Prize', 0)",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      dataSource.getRepository(RafflePurchase).save({
        raffleId,
        orderId: order.id,
        buyerName: "Buyer",
        buyerEmail: "buyer@example.test",
        buyerPhone: "+540000",
        unitPriceInCents: 0,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await dataSource.getRepository(RafflePurchase).save({
      raffleId,
      orderId: order.id,
      buyerName: "Buyer",
      buyerEmail: "buyer@example.test",
      buyerPhone: "+540000",
      unitPriceInCents: 1_000,
    });
    await expect(
      dataSource.getRepository(RafflePurchase).save({
        raffleId,
        orderId: order.id,
        buyerName: "Other",
        buyerEmail: "other@example.test",
        buyerPhone: "+540001",
        unitPriceInCents: 1_000,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("lists and returns detail with an exact number summary", async () => {
    const first = await createRaffle({ title: "Primera" });
    await createRaffle({ title: "Segunda" });
    const list = await request(app.getHttpServer())
      .get("/api/v1/admin/raffles?page=1&pageSize=1")
      .set(auth())
      .expect(200);
    expect(list.body).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(list.body.items).toHaveLength(1);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${first.body.id}`)
      .set(auth())
      .expect(200);
    expect(detail.body.numberSummary).toEqual({
      total: 100,
      available: 100,
      reserved: 0,
      sold: 0,
    });
  });

  it("updates only a DRAFT without regenerating or changing number IDs", async () => {
    const raffleId = (await createRaffle()).body.id;
    const before = await dataSource.getRepository(RaffleNumber).find({
      where: { raffleId },
      order: { number: "ASC" },
    });
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/admin/raffles/${raffleId}`)
      .set(auth())
      .send({
        title: "  Título actualizado  ",
        description: null,
        imageUrl: "https://example.com/new.jpg",
        priceInCents: 600_000,
        drawAt: null,
      })
      .expect(200);
    expect(response.body).toMatchObject({
      title: "Título actualizado",
      description: null,
      imageUrl: "https://example.com/new.jpg",
      priceInCents: 600_000,
      drawAt: null,
    });
    const after = await dataSource.getRepository(RaffleNumber).find({
      where: { raffleId },
      order: { number: "ASC" },
    });
    expect(after).toHaveLength(100);
    expect(after.map((number) => number.id)).toEqual(
      before.map((number) => number.id),
    );
    const audit = await dataSource
      .getRepository(AdminAuditLog)
      .findOneByOrFail({
        action: "RAFFLE_UPDATED",
        entityId: raffleId,
      });
    expect(audit.metadata?.changedFields).toEqual([
      "title",
      "description",
      "imageUrls",
      "priceInCents",
      "drawAt",
    ]);
  });

  it("rejects edits outside DRAFT with the stable domain error", async () => {
    const raffleId = (await createRaffle()).body.id;
    await dataSource.getRepository(Raffle).update(raffleId, {
      status: RaffleStatus.ACTIVE,
    });
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/admin/raffles/${raffleId}`)
      .set(auth())
      .send({ title: "Not allowed" })
      .expect(409);
    expect(response.body.code).toBe("RAFFLE_EDIT_NOT_ALLOWED");
  });

  it("accepts external HTTPS image URLs including Cloudinary", async () => {
    const response = await createRaffle({
      imageUrl: "  https://res.cloudinary.com/demo/image/upload/sample.jpg  ",
    });
    expect(response.body.imageUrl).toBe(
      "https://res.cloudinary.com/demo/image/upload/sample.jpg",
    );
    expect(response.body.imageUrls).toEqual([
      "https://res.cloudinary.com/demo/image/upload/sample.jpg",
    ]);
  });

  it.each([
    "http://example.com/image.jpg",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "texto",
  ])("rejects non-HTTPS image URL %s", async (imageUrl) => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/admin/raffles")
      .set(auth())
      .send(payload({ imageUrl }))
      .expect(400);
    expect(response.body.code).toBe("RAFFLE_INVALID_IMAGE_URL");
  });

  it.each([
    ["get", "/api/v1/admin/raffles"],
    ["post", "/api/v1/admin/raffles"],
    ["get", `/api/v1/admin/raffles/${crypto.randomUUID()}`],
    ["patch", `/api/v1/admin/raffles/${crypto.randomUUID()}`],
  ])("protects %s %s with existing Admin auth", async (method, path) => {
    const client = request(app.getHttpServer());
    const response =
      method === "post"
        ? client.post(path)
        : method === "patch"
          ? client.patch(path)
          : client.get(path);
    await response.expect(401);
  });
});
