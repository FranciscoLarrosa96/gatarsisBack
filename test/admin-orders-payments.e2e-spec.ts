import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import request = require("supertest");
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { AdminAuditLog } from "../src/admin/entities/admin-audit-log.entity";
import { AdminRole, AdminUser } from "../src/admin/entities/admin-user.entity";
import {
  InventoryMovement,
  InventoryMovementType,
} from "../src/inventory/entities/inventory-movement.entity";
import { Order, OrderKind, OrderPaymentSource, OrderStatus } from "../src/orders/entities/order.entity";
import { OrderItem } from "../src/orders/entities/order-item.entity";
import {
  Payment,
  PaymentProcessingStatus,
} from "../src/payments/entities/payment.entity";
import { Product } from "../src/products/entities/product.entity";
import { ProductVariant } from "../src/products/entities/product-variant.entity";
import { RaffleNumber, RaffleNumberStatus } from "../src/raffles/entities/raffle-number.entity";
import { RafflePurchase } from "../src/raffles/entities/raffle-purchase.entity";
import { Raffle, RaffleStatus } from "../src/raffles/entities/raffle.entity";

describe("admin orders and payments contracts (PostgreSQL)", () => {
  let app: INestApplication;
  let ds: DataSource;
  let token: string;
  let admin: AdminUser;
  beforeAll(async () => {
    process.env.DATABASE_NAME ??= "gatarsis_test";
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
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
      "TRUNCATE raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, inventory_movements, payments, payment_preferences, order_items, orders, inventory, product_variants, products RESTART IDENTITY CASCADE",
    );
    admin = await ds
      .getRepository(AdminUser)
      .save({
        email: "orders-admin@example.test",
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
  const auth = () => ({ Authorization: `Bearer ${token}` });
  async function fixture(status = PaymentProcessingStatus.REQUIRES_REVIEW) {
    const product = await ds.getRepository(Product).save({ slug: `fixture-${crypto.randomUUID()}`, name: "Catalog current", active: true });
    const variant = await ds.getRepository(ProductVariant).save({ productId: product.id, sku: `FIX-${crypto.randomUUID()}`, name: "Current variant", color: null, size: null, priceInCents: 999, active: true });
    const order = await ds
      .getRepository(Order)
      .save({
        status: OrderStatus.PAID,
        idempotencyKey: crypto.randomUUID(),
        requestFingerprint: null,
        subtotalInCents: 500,
        totalInCents: 500,
        reservationExpiresAt: new Date(),
        paidAt: null,
      });
    await ds.getRepository(OrderItem).save([
      {
        orderId: order.id,
        variantId: variant.id,
        productNameSnapshot: "Nombre histórico",
        variantNameSnapshot: "Variante histórica",
        skuSnapshot: "SKU-HIST",
        unitPriceInCents: 100,
        quantity: 3,
        lineTotalInCents: 300,
      },
      {
        orderId: order.id,
        variantId: variant.id,
        productNameSnapshot: "Otro histórico",
        variantNameSnapshot: "Otra variante",
        skuSnapshot: "SKU-OTRO",
        unitPriceInCents: 100,
        quantity: 2,
        lineTotalInCents: 200,
      },
    ]);
    const payment = await ds
      .getRepository(Payment)
      .save({
        orderId: order.id,
        provider: "mercado_pago",
        providerPaymentId: "mp-non-uuid-123",
        providerStatus: "approved",
        providerStatusDetail: null,
        processingStatus: status,
        transactionAmountInCents: 500,
        currencyId: "ARS",
        externalReference: "internal-only",
        paymentMethodId: null,
        paymentTypeId: null,
        dateCreated: null,
        dateApproved: null,
        dateLastUpdated: null,
        reviewReason:
          status === PaymentProcessingStatus.REQUIRES_REVIEW
            ? "Mismatch"
            : null,
        reviewResolvedAt: null,
        reviewResolvedByAdminId: null,
        reviewResolution: null,
        reviewNote: null,
      });
    await ds
      .getRepository(InventoryMovement)
      .save({
        variantId: variant.id,
        orderId: order.id,
        type: InventoryMovementType.RESERVE,
        onHandDelta: 0,
        reservedDelta: 5,
        reason: null,
      });
    return { order, payment };
  }
  it("returns explicit order/payment read models and stable nulls", async () => {
    const { order, payment } = await fixture();
    await request(app.getHttpServer())
      .get("/api/v1/admin/orders")
      .set(auth())
      .expect(200)
      .expect((r) => {
        expect(r.body.items[0]).toEqual(
          expect.objectContaining({
            id: order.id,
            kind: "MERCH",
            paymentSource: "MERCADO_PAGO",
            itemsCount: 5,
            paidAt: null,
            items: [
              { label: "Nombre histórico — Variante histórica", quantity: 3 },
              { label: "Otro histórico — Otra variante", quantity: 2 },
            ],
            paymentProcessingStatus: "REQUIRES_REVIEW",
          }),
        );
        expect(r.body.items[0]).not.toHaveProperty("idempotencyKey");
      });
    await request(app.getHttpServer())
      .get(`/api/v1/admin/orders/${order.id}`)
      .set(auth())
      .expect(200)
      .expect((r) => {
        expect(r.body).toEqual(
          expect.objectContaining({
            order: expect.objectContaining({ id: order.id, paidAt: null }),
            items: expect.arrayContaining([
              expect.objectContaining({ skuSnapshot: "SKU-HIST", quantity: 3 }),
            ]),
            paymentPreference: null,
          }),
        );
        expect(JSON.stringify(r.body)).not.toContain("idempotencyKey");
      });
    await request(app.getHttpServer())
      .get(`/api/v1/admin/payments/${payment.id}`)
      .set(auth())
      .expect(200)
      .expect((r) => {
        expect(r.body.payment).toEqual(
          expect.objectContaining({
            id: payment.id,
            providerPaymentId: "mp-non-uuid-123",
            dateApproved: null,
            reviewResolvedAt: null,
          }),
        );
        expect(JSON.stringify(r.body)).not.toContain("externalReference");
      });
    await request(app.getHttpServer())
      .get("/api/v1/admin/payments/mp-non-uuid-123")
      .set(auth())
      .expect(400);
  });
  it("returns raffle type, buyer, title, and numbers in the same paginated orders list", async () => {
    const raffle = await ds.getRepository(Raffle).save({
      title: "Rifa solidaria",
      prizeName: "Premio",
      priceInCents: 5000,
      status: RaffleStatus.ACTIVE,
      description: null,
      imageUrls: [],
      drawAt: null,
      winningNumber: null,
      drawnAt: null,
      drawnByAdminId: null,
    });
    const order = await ds.getRepository(Order).save({
      kind: OrderKind.RAFFLE,
      status: OrderStatus.PAID,
      paymentSource: OrderPaymentSource.MANUAL,
      idempotencyKey: crypto.randomUUID(),
      requestFingerprint: null,
      subtotalInCents: 15000,
      totalInCents: 15000,
      reservationExpiresAt: new Date(),
      paidAt: new Date(),
    });
    const purchase = await ds.getRepository(RafflePurchase).save({
      raffleId: raffle.id,
      orderId: order.id,
      buyerName: "Francisco Larrosa",
      buyerEmail: "francisco@example.test",
      buyerPhone: "+54 249 4000000",
      unitPriceInCents: 5000,
      manualPaymentMethod: null,
      manualPaymentNote: null,
    });
    await ds.getRepository(RaffleNumber).save([7, 23, 48].map((number) => ({
      raffleId: raffle.id,
      number,
      status: RaffleNumberStatus.SOLD,
      rafflePurchaseId: purchase.id,
      reservedUntil: null,
      reservedAt: null,
      soldAt: new Date(),
    })));

    await request(app.getHttpServer())
      .get("/api/v1/admin/orders")
      .set(auth())
      .expect(200)
      .expect((response) => {
        expect(response.body.items[0]).toEqual(expect.objectContaining({
          id: order.id,
          kind: "RAFFLE",
          itemsCount: 0,
          customer: {
            name: "Francisco Larrosa",
            email: "francisco@example.test",
            phone: "+54 249 4000000",
          },
          raffle: { title: "Rifa solidaria", numbers: [7, 23, 48] },
          paymentProcessingStatus: null,
        }));
      });
  });
  it("resolves review once without changing payment business state", async () => {
    const { payment } = await fixture();
    await request(app.getHttpServer())
      .get("/api/v1/admin/payments/review")
      .set(auth())
      .expect(200)
      .expect((r) => expect(r.body.items).toHaveLength(1));
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${payment.id}/review/resolve`)
      .set(auth())
      .send({
        resolution: "ACKNOWLEDGED_NO_ACTION",
        note: "Revisado manualmente",
      })
      .expect(201);
    const resolved = await ds
      .getRepository(Payment)
      .findOneByOrFail({ id: payment.id });
    expect(resolved).toMatchObject({
      processingStatus: PaymentProcessingStatus.REQUIRES_REVIEW,
      providerStatus: "approved",
      reviewResolution: "ACKNOWLEDGED_NO_ACTION",
      reviewResolvedByAdminId: admin.id,
      reviewNote: "Revisado manualmente",
    });
    expect(
      await ds
        .getRepository(AdminAuditLog)
        .countBy({ action: "PAYMENT_REVIEW_RESOLVED", entityId: payment.id }),
    ).toBe(1);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/payments/${payment.id}/review/resolve`)
      .set(auth())
      .send({
        resolution: "MANUAL_INVESTIGATION_COMPLETE",
        note: "Second attempt",
      })
      .expect(409);
    await request(app.getHttpServer())
      .get("/api/v1/admin/payments/review")
      .set(auth())
      .expect(200)
      .expect((r) => expect(r.body.items).toHaveLength(0));
  });
});
