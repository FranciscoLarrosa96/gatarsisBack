import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import request = require("supertest");
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { AdminAuditLog } from "../src/admin/entities/admin-audit-log.entity";
import { AdminRole, AdminUser } from "../src/admin/entities/admin-user.entity";
import { Inventory } from "../src/inventory/entities/inventory.entity";
import {
  InventoryMovement,
  InventoryMovementType,
} from "../src/inventory/entities/inventory-movement.entity";
import {
  Order,
  OrderKind,
  OrderPaymentSource,
  OrderStatus,
} from "../src/orders/entities/order.entity";
import { OrderItem } from "../src/orders/entities/order-item.entity";
import {
  FulfillmentStatus,
  OrderFulfillment,
} from "../src/orders/entities/order-fulfillment.entity";
import { OrdersService } from "../src/orders/orders.service";
import { ManualPaymentMethod } from "../src/orders/manual-payment-method";
import { Payment } from "../src/payments/entities/payment.entity";
import { PaymentPreference } from "../src/payments/entities/payment-preference.entity";
import { MERCADO_PAGO_GATEWAY } from "../src/payments/mercado-pago.gateway";
import { Product } from "../src/products/entities/product.entity";
import { ProductVariant } from "../src/products/entities/product-variant.entity";

describe("admin manual store sales (PostgreSQL)", () => {
  let app: INestApplication;
  let ds: DataSource;
  let token: string;
  let admin: AdminUser;
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
      "TRUNCATE raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, refund_operations, inventory_movements, payments, payment_preferences, order_fulfillments, order_items, orders, inventory, product_media, product_variants, products RESTART IDENTITY CASCADE",
    );
    admin = await ds.getRepository(AdminUser).save({
      email: `store-${crypto.randomUUID()}@example.test`,
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

  async function variant(stock = 5, priceInCents = 500_000) {
    const product = await ds
      .getRepository(Product)
      .save({
        slug: `manual-${crypto.randomUUID()}`,
        name: "Llavero Gatarsis",
        active: true,
      });
    const created = await ds.getRepository(ProductVariant).save({
      productId: product.id,
      sku: `MAN-${crypto.randomUUID()}`,
      name: "Patita · T3",
      model: "Patita",
      color: "Rojo",
      size: "T3",
      attributes: {},
      priceInCents,
      active: true,
    });
    await ds
      .getRepository(Inventory)
      .save({ variantId: created.id, stockOnHand: stock, reservedStock: 0 });
    return created;
  }

  const payload = (
    items: { variantId: string; quantity: number }[],
    overrides: Record<string, unknown> = {},
  ) => ({
    customer: {
      name: " María Piloni ",
      email: " MARIA@EXAMPLE.TEST ",
      phone: " +54 249 1234567 ",
    },
    items,
    paymentMethod: "TRANSFER",
    paymentReceived: true,
    note: " Venta por WhatsApp ",
    idempotencyKey: `store-${crypto.randomUUID()}`,
    ...overrides,
  });
  const sell = (body: object) =>
    request(app.getHttpServer())
      .post("/api/v1/admin/orders/manual")
      .set(auth())
      .send(body);
  const stock = (variantId: string) =>
    ds.getRepository(Inventory).findOneByOrFail({ variantId });

  async function expectNoSale() {
    const counts = await Promise.all([
      ds.getRepository(Order).count(),
      ds.getRepository(OrderItem).count(),
      ds.getRepository(OrderFulfillment).count(),
      ds.getRepository(InventoryMovement).count(),
      ds
        .getRepository(AdminAuditLog)
        .countBy({ action: "STORE_MANUAL_SALE_CREATED" }),
      ds.getRepository(Payment).count(),
      ds.getRepository(PaymentPreference).count(),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
  }

  it("requires an authenticated active admin", async () => {
    const v = await variant();
    const body = payload([{ variantId: v.id, quantity: 1 }]);
    await request(app.getHttpServer())
      .post("/api/v1/admin/orders/manual")
      .send(body)
      .expect(401);
    await ds.getRepository(AdminUser).update(admin.id, { active: false });
    await sell(body).expect(401);
    await expectNoSale();
  });

  it("creates a PAID/MANUAL merchandise order with DB prices, snapshots, buyer, pending delivery and audit", async () => {
    const first = await variant(5, 500_000);
    const second = await variant(4, 750_000);
    const response = await sell(
      payload([
        { variantId: first.id, quantity: 1 },
        { variantId: second.id, quantity: 2 },
      ]),
    ).expect(201);
    expect(response.body).toMatchObject({
      kind: "MERCH",
      status: "PAID",
      paymentSource: "MANUAL",
      paymentMethod: "TRANSFER",
      note: "Venta por WhatsApp",
      totalInCents: 2_000_000,
      customer: {
        name: "María Piloni",
        email: "maria@example.test",
        phone: "+54 249 1234567",
      },
      fulfillment: { method: "PICKUP", status: "PENDING" },
    });
    expect(response.body.paidAt).toBeTruthy();
    const order = await ds
      .getRepository(Order)
      .findOneByOrFail({ id: response.body.orderId });
    expect(order).toMatchObject({
      kind: OrderKind.MERCH,
      status: OrderStatus.PAID,
      paymentSource: OrderPaymentSource.MANUAL,
      manualPaymentMethod: ManualPaymentMethod.TRANSFER,
      subtotalInCents: 2_000_000,
    });
    expect(await stock(first.id)).toMatchObject({
      stockOnHand: 4,
      reservedStock: 0,
    });
    expect(await stock(second.id)).toMatchObject({
      stockOnHand: 2,
      reservedStock: 0,
    });
    const snapshots = await ds
      .getRepository(OrderItem)
      .findBy({ orderId: order.id });
    expect(snapshots).toHaveLength(2);
    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variantId: first.id,
          productNameSnapshot: "Llavero Gatarsis",
          variantNameSnapshot: "Patita · T3",
          unitPriceInCents: 500_000,
          quantity: 1,
        }),
        expect.objectContaining({
          variantId: second.id,
          unitPriceInCents: 750_000,
          quantity: 2,
          lineTotalInCents: 1_500_000,
        }),
      ]),
    );
    const audit = await ds
      .getRepository(AdminAuditLog)
      .findOneByOrFail({
        entityId: order.id,
        action: "STORE_MANUAL_SALE_CREATED",
      });
    expect(audit).toMatchObject({
      adminUserId: admin.id,
      metadata: {
        itemsCount: 3,
        lineCount: 2,
        totalInCents: 2_000_000,
        paymentMethod: "TRANSFER",
        createdByAdminId: admin.id,
      },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("maria@example.test");
    expect(await ds.getRepository(Payment).count()).toBe(0);
    expect(await ds.getRepository(PaymentPreference).count()).toBe(0);
    for (const method of Object.values(gateway))
      expect(method).not.toHaveBeenCalled();
    expect(
      await app
        .get(OrdersService)
        .expireReservations(new Date(Date.now() + 60_000)),
    ).toBe(0);
  });

  it.each(["CASH", "TRANSFER", "OTHER"])(
    "persists payment method %s with optional contact data",
    async (paymentMethod) => {
      const v = await variant();
      const response = await sell(
        payload([{ variantId: v.id, quantity: 1 }], {
          customer: { name: "María Piloni" },
          paymentMethod,
        }),
      ).expect(201);
      expect(response.body).toMatchObject({
        paymentMethod,
        customer: { name: "María Piloni", email: null, phone: null },
      });
      expect(
        await ds
          .getRepository(OrderFulfillment)
          .findOneByOrFail({ orderId: response.body.orderId }),
      ).toMatchObject({
        status: FulfillmentStatus.PENDING,
        customerEmail: null,
        customerPhone: null,
      });
    },
  );

  const invalid: [string, (id: string) => Record<string, unknown>][] = [
    ["missing customer", () => ({ customer: undefined })],
    ["empty customer name", () => ({ customer: { name: "   " } })],
    [
      "invalid email",
      () => ({ customer: { name: "Buyer", email: "invalid" } }),
    ],
    ["invalid payment method", () => ({ paymentMethod: "MERCADO_PAGO" })],
    ["unconfirmed payment", () => ({ paymentReceived: false })],
    ["missing confirmation", () => ({ paymentReceived: undefined })],
    ["missing idempotency key", () => ({ idempotencyKey: undefined })],
    ["empty cart", () => ({ items: [] })],
    ["zero quantity", (id) => ({ items: [{ variantId: id, quantity: 0 }] })],
    [
      "negative quantity",
      (id) => ({ items: [{ variantId: id, quantity: -1 }] }),
    ],
    [
      "fractional quantity",
      (id) => ({ items: [{ variantId: id, quantity: 1.5 }] }),
    ],
    [
      "string quantity",
      (id) => ({ items: [{ variantId: id, quantity: "1" }] }),
    ],
    [
      "duplicate variant",
      (id) => ({
        items: [
          { variantId: id, quantity: 1 },
          { variantId: id.toUpperCase(), quantity: 1 },
        ],
      }),
    ],
    [
      "invalid variant id",
      () => ({ items: [{ variantId: "invalid", quantity: 1 }] }),
    ],
    ["manipulated total", () => ({ totalInCents: 1 })],
    [
      "manipulated unit price",
      (id) => ({
        items: [{ variantId: id, quantity: 1, unitPriceInCents: 1 }],
      }),
    ],
  ];
  it.each(invalid)(
    "rejects %s before creating any sale",
    async (_name, overrides) => {
      const v = await variant();
      await sell(
        payload([{ variantId: v.id, quantity: 1 }], overrides(v.id)),
      ).expect(400);
      expect(await stock(v.id)).toMatchObject({
        stockOnHand: 5,
        reservedStock: 0,
      });
      await expectNoSale();
    },
  );

  it("rejects nonexistent and inactive variants and inactive products", async () => {
    expect(
      (
        await sell(
          payload([{ variantId: crypto.randomUUID(), quantity: 1 }]),
        ).expect(404)
      ).body.code,
    ).toBe("VARIANT_NOT_FOUND");
    const v = await variant();
    await ds.getRepository(ProductVariant).update(v.id, { active: false });
    expect(
      (await sell(payload([{ variantId: v.id, quantity: 1 }])).expect(409)).body
        .code,
    ).toBe("VARIANT_INACTIVE");
    await ds.getRepository(ProductVariant).update(v.id, { active: true });
    await ds.getRepository(Product).update(v.productId, { active: false });
    expect(
      (await sell(payload([{ variantId: v.id, quantity: 1 }])).expect(409)).body
        .code,
    ).toBe("PRODUCT_INACTIVE");
    await expectNoSale();
  });

  it("rejects zero stock and preserves stock reserved by web orders", async () => {
    const v = await variant(0);
    expect(
      (await sell(payload([{ variantId: v.id, quantity: 1 }])).expect(409)).body
        .code,
    ).toBe("OUT_OF_STOCK");
    await expectNoSale();
    await ds
      .getRepository(Inventory)
      .update({ variantId: v.id }, { stockOnHand: 5, reservedStock: 2 });
    expect(
      (await sell(payload([{ variantId: v.id, quantity: 4 }])).expect(409)).body
        .code,
    ).toBe("OUT_OF_STOCK");
    await expectNoSale();
    await sell(payload([{ variantId: v.id, quantity: 3 }])).expect(201);
    expect(await stock(v.id)).toMatchObject({
      stockOnHand: 2,
      reservedStock: 2,
    });
    const sale = await ds
      .getRepository(InventoryMovement)
      .findOneByOrFail({ type: InventoryMovementType.SALE });
    expect(sale).toMatchObject({
      onHandDelta: -3,
      reservedDelta: -3,
      reason: "Manual store sale",
    });
  });

  it("rolls back earlier items when the last item has insufficient stock", async () => {
    const variants = [await variant(2), await variant(2)].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    await ds
      .getRepository(Inventory)
      .update({ variantId: variants[1].id }, { stockOnHand: 0 });
    await sell(
      payload(variants.map((v) => ({ variantId: v.id, quantity: 1 }))),
    ).expect(409);
    expect(await stock(variants[0].id)).toMatchObject({
      stockOnHand: 2,
      reservedStock: 0,
    });
    await expectNoSale();
  });

  it("rolls back stock, order, items, fulfillment and movements when audit persistence fails", async () => {
    const v = await variant(2);
    await ds.query(`CREATE FUNCTION test_manual_store_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'STORE_MANUAL_SALE_CREATED' THEN RAISE EXCEPTION 'test manual audit failure'; END IF; RETURN NEW; END $$`);
    try {
      await ds.query(
        "CREATE TRIGGER test_manual_store_audit_failure BEFORE INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION test_manual_store_audit_failure()",
      );
      await sell(payload([{ variantId: v.id, quantity: 1 }])).expect(500);
      expect(await stock(v.id)).toMatchObject({
        stockOnHand: 2,
        reservedStock: 0,
      });
      await expectNoSale();
    } finally {
      await ds.query(
        "DROP TRIGGER IF EXISTS test_manual_store_audit_failure ON admin_audit_logs",
      );
      await ds.query(
        "DROP FUNCTION IF EXISTS test_manual_store_audit_failure()",
      );
    }
  });

  it("replays 20 concurrent equal requests once and rejects reuse with a different cart", async () => {
    const v = await variant(2);
    const body = payload([{ variantId: v.id, quantity: 1 }]);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => sell(body)),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(
      new Set(responses.map((response) => response.body.orderId)).size,
    ).toBe(1);
    expect(await stock(v.id)).toMatchObject({
      stockOnHand: 1,
      reservedStock: 0,
    });
    expect(await ds.getRepository(Order).count()).toBe(1);
    expect(
      await ds
        .getRepository(InventoryMovement)
        .countBy({ type: InventoryMovementType.SALE }),
    ).toBe(1);
    expect(
      await ds
        .getRepository(AdminAuditLog)
        .countBy({ action: "STORE_MANUAL_SALE_CREATED" }),
    ).toBe(1);
    const reordered = {
      ...body,
      customer: {
        phone: body.customer.phone,
        name: body.customer.name,
        email: body.customer.email,
      },
    };
    expect((await sell(reordered).expect(201)).body.orderId).toBe(
      responses[0].body.orderId,
    );
    expect(
      (
        await sell({
          ...body,
          items: [{ variantId: v.id, quantity: 2 }],
        }).expect(409)
      ).body.code,
    ).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("allows one of 20 concurrent distinct manual sales to consume the last unit", async () => {
    const v = await variant(1);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        sell(payload([{ variantId: v.id, quantity: 1 }])),
      ),
    );
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(1);
    expect(
      responses.filter(
        (response) =>
          response.status === 409 && response.body.code === "OUT_OF_STOCK",
      ),
    ).toHaveLength(19);
    expect(await stock(v.id)).toMatchObject({
      stockOnHand: 0,
      reservedStock: 0,
    });
    expect(await ds.getRepository(Order).count()).toBe(1);
    expect(
      await ds
        .getRepository(InventoryMovement)
        .countBy({ type: InventoryMovementType.SALE }),
    ).toBe(1);
  });

  it("allows exactly one winner between manual sale and public web reservation", async () => {
    const v = await variant(1);
    const [manual, web] = await Promise.all([
      sell(payload([{ variantId: v.id, quantity: 1 }])),
      request(app.getHttpServer())
        .post("/api/v1/checkout/reserve")
        .set("Idempotency-Key", `web-${crypto.randomUUID()}`)
        .set("X-Forwarded-For", crypto.randomUUID())
        .send({
          items: [{ variantId: v.id, quantity: 1 }],
          customer: {
            name: "Web Buyer",
            email: "web@example.test",
            phone: "2491234567",
          },
          fulfillment: { method: "PICKUP" },
        }),
    ]);
    expect([manual.status, web.status].sort()).toEqual([201, 409]);
    expect(await ds.getRepository(Order).count()).toBe(1);
    expect(await stock(v.id)).toMatchObject(
      manual.status === 201
        ? { stockOnHand: 0, reservedStock: 0 }
        : { stockOnHand: 1, reservedStock: 1 },
    );
  });

  it("shows manual sale details in Orders and the orders-based simple Payments feed", async () => {
    const v = await variant();
    const created = await sell(
      payload([{ variantId: v.id, quantity: 2 }]),
    ).expect(201);
    await ds
      .getRepository(ProductVariant)
      .update(v.id, { name: "New name", priceInCents: 1_000_000 });
    const list = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders?orderId=${created.body.orderId}`)
      .set(auth())
      .expect(200);
    expect(list.body.items[0]).toMatchObject({
      id: created.body.orderId,
      kind: "MERCH",
      status: "PAID",
      paymentSource: "MANUAL",
      manualPaymentMethod: "TRANSFER",
      manualSaleNote: "Venta por WhatsApp",
      totalInCents: 1_000_000,
      itemsCount: 2,
      customer: { name: "María Piloni", email: "maria@example.test" },
      items: [{ label: "Llavero Gatarsis — Patita · T3", quantity: 2 }],
      raffle: null,
      paymentProcessingStatus: null,
    });
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${created.body.orderId}`)
      .set(auth())
      .expect(200);
    expect(detail.body.order).toMatchObject({
      paymentSource: "MANUAL",
      manualPaymentMethod: "TRANSFER",
      totalInCents: 1_000_000,
    });
    expect(detail.body.items[0]).toMatchObject({
      variantNameSnapshot: "Patita · T3",
      unitPriceInCents: 500_000,
    });
    expect(detail.body.payments).toEqual([]);
    expect(detail.body.paymentPreference).toBeNull();
    expect(detail.body.fulfillment).toMatchObject({
      status: "PENDING",
      customer: { name: "María Piloni" },
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${created.body.orderId}/fulfillment`)
      .set(auth())
      .send({ status: "READY_FOR_PICKUP" })
      .expect(200);
  });
});
