import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import request = require("supertest");
import { DataSource } from "typeorm";
import { AdminAuditLog } from "../src/admin/entities/admin-audit-log.entity";
import { AdminRole, AdminUser } from "../src/admin/entities/admin-user.entity";
import { AppModule } from "../src/app.module";
import { RaffleImageGallery1767571200000 } from "../src/database/migrations/1767571200000-RaffleImageGallery";
import { Raffle, RaffleStatus } from "../src/raffles/entities/raffle.entity";

describe("raffle image gallery (PostgreSQL)", () => {
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
      "TRUNCATE adoptable_cats, raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, refund_operations, inventory_movements, payments, payment_preferences, order_fulfillments, order_items, orders, inventory, product_media, product_variants, products RESTART IDENTITY CASCADE",
    );
    const admin = await ds.getRepository(AdminUser).save({
      email: `gallery-${crypto.randomUUID()}@example.test`,
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

  const body = (overrides: Record<string, unknown> = {}) => ({
    title: "Rifa con galería",
    prizeName: "Premio",
    description: "Galería del premio",
    priceInCents: 25_000,
    imageUrls: ["https://res.cloudinary.com/demo/image/upload/main.webp"],
    ...overrides,
  });

  function create(overrides: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post("/api/v1/admin/raffles")
      .set(auth())
      .send(body(overrides));
  }

  it("creates a raffle with one image and exposes the compatibility cover", async () => {
    const response = await create().expect(201);
    expect(response.body.imageUrls).toEqual([
      "https://res.cloudinary.com/demo/image/upload/main.webp",
    ]);
    expect(response.body.imageUrl).toBe(response.body.imageUrls[0]);
  });

  it("creates multiple images preserving their exact order and first cover", async () => {
    const imageUrls = [
      "https://cdn.example.test/cover.webp",
      "https://cdn.example.test/detail-2.webp",
      "https://cdn.example.test/detail-1.webp",
    ];
    const response = await create({ imageUrls }).expect(201);
    expect(response.body.imageUrls).toEqual(imageUrls);
    expect(response.body.imageUrl).toBe(imageUrls[0]);
    const stored = await ds.getRepository(Raffle).findOneByOrFail({
      id: response.body.id,
    });
    expect(stored.imageUrls).toEqual(imageUrls);
  });

  it("trims URLs and removes duplicates without changing first occurrence order", async () => {
    const response = await create({
      imageUrls: [
        " https://cdn.example.test/one.webp ",
        "https://cdn.example.test/two.webp",
        "https://cdn.example.test/one.webp",
      ],
    }).expect(201);
    expect(response.body.imageUrls).toEqual([
      "https://cdn.example.test/one.webp",
      "https://cdn.example.test/two.webp",
    ]);
  });

  it.each([[[""]], [["texto cualquiera"]], [["https://"]]])(
    "rejects an invalid gallery %j",
    async (imageUrls) => {
      const response = await create({ imageUrls }).expect(400);
      expect(response.body.code).toBe("RAFFLE_INVALID_IMAGE_URL");
    },
  );

  it("rejects HTTP and more than eight images", async () => {
    const http = await create({
      imageUrls: ["http://cdn.example.test/image.webp"],
    }).expect(400);
    expect(http.body.code).toBe("RAFFLE_INVALID_IMAGE_URL");
    await create({
      imageUrls: Array.from(
        { length: 9 },
        (_, index) => `https://cdn.example.test/${index}.webp`,
      ),
    }).expect(400);
  });

  it("allows an empty gallery because images are optional in the existing raffle rule", async () => {
    const response = await create({ imageUrls: [] }).expect(201);
    expect(response.body.imageUrls).toEqual([]);
    expect(response.body.imageUrl).toBeNull();
  });

  it("migrates the legacy image_url into a one-element JSON array without loss", async () => {
    const runner = ds.createQueryRunner();
    const migration = new RaffleImageGallery1767571200000();
    await runner.connect();
    await runner.startTransaction();
    try {
      await migration.down(runner);
      const legacyUrl = "https://res.cloudinary.com/demo/image/upload/legacy.webp";
      const rows = await runner.query(
        `INSERT INTO raffles (title, prize_name, image_url, price_in_cents) VALUES ($1, $2, $3, $4) RETURNING id`,
        ["Legacy", "Legacy prize", legacyUrl, 10_000],
      );
      await migration.up(runner);
      const migrated = await runner.query(
        `SELECT image_urls FROM raffles WHERE id = $1`,
        [rows[0].id],
      );
      expect(migrated[0].image_urls).toEqual([legacyUrl]);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it("updates and reorders a DRAFT gallery with an imageUrls audit field", async () => {
    const created = await create().expect(201);
    const reordered = [
      "https://cdn.example.test/new-cover.webp",
      "https://res.cloudinary.com/demo/image/upload/main.webp",
    ];
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/admin/raffles/${created.body.id}`)
      .set(auth())
      .send({ imageUrls: reordered })
      .expect(200);
    expect(response.body.imageUrls).toEqual(reordered);
    expect(response.body.imageUrl).toBe(reordered[0]);
    const audit = await ds.getRepository(AdminAuditLog).findOneByOrFail({
      action: "RAFFLE_UPDATED",
      entityId: created.body.id,
    });
    expect(audit.metadata?.changedFields).toEqual(["imageUrls"]);
  });

  it("returns imageUrls and the first-image alias from the public API", async () => {
    const imageUrls = [
      "https://cdn.example.test/cover.webp",
      "https://cdn.example.test/detail.webp",
    ];
    const created = await create({ imageUrls }).expect(201);
    await ds.getRepository(Raffle).update(created.body.id, {
      status: RaffleStatus.ACTIVE,
    });
    const response = await request(app.getHttpServer())
      .get(`/api/v1/raffles/${created.body.id}`)
      .expect(200);
    expect(response.body.imageUrls).toEqual(imageUrls);
    expect(response.body.imageUrl).toBe(imageUrls[0]);
  });

  it("accepts the deprecated imageUrl input and converts it to the final array model", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/admin/raffles")
      .set(auth())
      .send({
        title: "Legacy admin",
        prizeName: "Legacy prize",
        priceInCents: 20_000,
        imageUrl: " https://cdn.example.test/legacy-admin.webp ",
      })
      .expect(201);
    expect(response.body).toMatchObject({
      imageUrls: ["https://cdn.example.test/legacy-admin.webp"],
      imageUrl: "https://cdn.example.test/legacy-admin.webp",
    });
  });
});
