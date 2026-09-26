import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import ExcelJS = require("exceljs");
import request = require("supertest");
import { Response as SuperAgentResponse } from "superagent";
import { DataSource } from "typeorm";
import { AdminRole, AdminUser } from "../src/admin/entities/admin-user.entity";
import { AppModule } from "../src/app.module";
import {
  Order,
  OrderKind,
  OrderPaymentSource,
  OrderStatus,
} from "../src/orders/entities/order.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "../src/raffles/entities/raffle-number.entity";
import { RafflePurchase } from "../src/raffles/entities/raffle-purchase.entity";
import { Raffle, RaffleStatus } from "../src/raffles/entities/raffle.entity";

describe("admin raffle participant exports (PostgreSQL)", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const binaryParser = (
    response: SuperAgentResponse,
    callback: (error: Error | null, body: any) => void,
  ) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => callback(null, Buffer.concat(chunks)));
    response.on("error", callback);
  };

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
      email: `raffle-export-${crypto.randomUUID()}@example.test`,
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

  async function raffle() {
    return dataSource.getRepository(Raffle).save({
      title: "Rifa solidaria",
      prizeName: "Air Fryer Zenith",
      description: null,
      imageUrls: [],
      priceInCents: 500_000,
      status: RaffleStatus.ACTIVE,
      drawAt: null,
      winningNumber: null,
      drawnAt: null,
      drawnByAdminId: null,
    });
  }

  async function attach(
    raffleId: string,
    number: number,
    numberStatus: RaffleNumberStatus,
    orderStatus: OrderStatus,
    source: OrderPaymentSource,
    buyer: { name: string; email: string; phone: string },
  ) {
    const paid = orderStatus === OrderStatus.PAID;
    const order = await dataSource.getRepository(Order).save({
      kind: OrderKind.RAFFLE,
      status: orderStatus,
      paymentSource: source,
      idempotencyKey: crypto.randomUUID(),
      requestFingerprint: null,
      subtotalInCents: 500_000,
      totalInCents: 500_000,
      reservationExpiresAt: new Date(Date.now() + 60_000),
      paidAt: paid ? new Date("2026-09-26T19:00:00.000Z") : null,
    });
    const purchase = await dataSource.getRepository(RafflePurchase).save({
      raffleId,
      orderId: order.id,
      buyerName: buyer.name,
      buyerEmail: buyer.email,
      buyerPhone: buyer.phone,
      unitPriceInCents: 500_000,
      manualPaymentMethod: null,
      manualPaymentNote: null,
    });
    await dataSource.getRepository(RaffleNumber).save({
      raffleId,
      number,
      status: numberStatus,
      rafflePurchaseId: purchase.id,
      reservedAt: new Date(),
      reservedUntil:
        numberStatus === RaffleNumberStatus.RESERVED
          ? new Date(Date.now() + 60_000)
          : null,
      soldAt:
        numberStatus === RaffleNumberStatus.SOLD
          ? new Date("2026-09-26T19:00:00.000Z")
          : null,
    });
    return { order, purchase };
  }

  async function populatedRaffle() {
    const entity = await raffle();
    await dataSource.getRepository(RaffleNumber).save({
      raffleId: entity.id,
      number: 1,
      status: RaffleNumberStatus.AVAILABLE,
      rafflePurchaseId: null,
      reservedAt: null,
      reservedUntil: null,
      soldAt: null,
    });
    await attach(
      entity.id,
      2,
      RaffleNumberStatus.RESERVED,
      OrderStatus.AWAITING_PAYMENT,
      OrderPaymentSource.MERCADO_PAGO,
      {
        name: "Reserva Pendiente",
        email: "reserved@example.test",
        phone: "2494000002",
      },
    );
    await attach(
      entity.id,
      7,
      RaffleNumberStatus.SOLD,
      OrderStatus.PAID,
      OrderPaymentSource.MERCADO_PAGO,
      {
        name: "Francisco Larrosa",
        email: "francisco@example.test",
        phone: "2494000007",
      },
    );
    await attach(
      entity.id,
      12,
      RaffleNumberStatus.SOLD,
      OrderStatus.PAID,
      OrderPaymentSource.MANUAL,
      {
        name: "Aldana Salazar",
        email: "aldana@example.test",
        phone: "2494000012",
      },
    );
    await attach(
      entity.id,
      18,
      RaffleNumberStatus.SOLD,
      OrderStatus.REFUNDED,
      OrderPaymentSource.MERCADO_PAGO,
      {
        name: "Compra Reembolsada",
        email: "refunded@example.test",
        phone: "2494000018",
      },
    );
    return entity;
  }

  it.each(["xlsx", "pdf"])(
    "requires admin authentication for %s",
    async (format) => {
      const entity = await raffle();
      await request(app.getHttpServer())
        .get(`/api/v1/admin/raffles/${entity.id}/export/${format}`)
        .expect(401);
    },
  );

  it.each(["xlsx", "pdf"])(
    "returns 404 for an unknown raffle in %s",
    async (format) => {
      await request(app.getHttpServer())
        .get(`/api/v1/admin/raffles/${crypto.randomUUID()}/export/${format}`)
        .set(auth())
        .expect(404);
    },
  );

  it("exports a real XLSX with only eligible online and manual participants", async () => {
    const entity = await populatedRaffle();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${entity.id}/export/xlsx`)
      .set(auth())
      .buffer(true)
      .parse(binaryParser)
      .expect(200)
      .expect("Content-Type", /spreadsheetml/)
      .expect(
        "Content-Disposition",
        'attachment; filename="gatarsis-rifa-solidaria-participantes.xlsx"',
      );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(response.body as Uint8Array) as unknown as Parameters<
        typeof workbook.xlsx.load
      >[0],
    );
    const sheet = workbook.getWorksheet("Participantes")!;
    expect(sheet.getCell("B7").value).toBe(2);
    expect(sheet.getCell("B8").value).toBe(1);
    expect(sheet.getCell("B9").value).toBe(1);
    expect(sheet.getCell("B10").value).toBe(10_000);
    const rows = [sheet.getRow(13).values, sheet.getRow(14).values];
    expect(rows).toEqual([
      expect.arrayContaining([
        "07",
        "Francisco Larrosa",
        "francisco@example.test",
        "Online",
      ]),
      expect.arrayContaining([
        "12",
        "Aldana Salazar",
        "aldana@example.test",
        "Manual",
      ]),
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("Reserva Pendiente");
    expect(serialized).not.toContain("Compra Reembolsada");
  });

  it("exports a valid privacy-safe PDF ordered by participant number", async () => {
    const entity = await populatedRaffle();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${entity.id}/export/pdf`)
      .set(auth())
      .buffer(true)
      .parse(binaryParser)
      .expect(200)
      .expect("Content-Type", /application\/pdf/)
      .expect(
        "Content-Disposition",
        'attachment; filename="gatarsis-rifa-solidaria-participantes.pdf"',
      );
    const buffer = response.body as Buffer;
    const raw = buffer.toString("latin1");
    const decodedText = [...raw.matchAll(/<([0-9a-f]+)>/gi)]
      .map((match) => Buffer.from(match[1], "hex").toString("latin1"))
      .join("");
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(raw.match(/\/Type \/Page\b/g)).toHaveLength(1);
    expect(decodedText).toContain("Francisco Larrosa");
    expect(decodedText).toContain("Aldana Salazar");
    expect(decodedText.indexOf("Francisco Larrosa")).toBeLessThan(
      decodedText.indexOf("Aldana Salazar"),
    );
    expect(decodedText).not.toContain("francisco@example.test");
    expect(decodedText).not.toContain("2494000007");
    expect(decodedText).not.toContain("Reserva Pendiente");
    expect(decodedText).not.toContain("Compra Reembolsada");
  });

  it.each(["xlsx", "pdf"])(
    "returns a domain 409 instead of an empty %s",
    async (format) => {
      const entity = await raffle();
      const response = await request(app.getHttpServer())
        .get(`/api/v1/admin/raffles/${entity.id}/export/${format}`)
        .set(auth())
        .expect(409);
      expect(response.body.code).toBe("RAFFLE_PARTICIPANTS_NOT_AVAILABLE");
    },
  );

  it("keeps the existing numbers batch endpoint and adds list metadata without N+1 calls", async () => {
    const entity = await populatedRaffle();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/raffles/${entity.id}/numbers`)
      .set(auth())
      .expect(200);
    const manual = response.body.find(
      (item: { number: number }) => item.number === 12,
    );
    expect(manual).toMatchObject({
      number: 12,
      status: RaffleNumberStatus.SOLD,
      buyer: { name: "Aldana Salazar" },
      purchase: { unitPriceInCents: 500_000 },
      paymentSource: OrderPaymentSource.MANUAL,
      totalInCents: 500_000,
      order: {
        status: OrderStatus.PAID,
      },
    });
  });
});
