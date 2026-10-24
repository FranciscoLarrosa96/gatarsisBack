import { Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash } from "crypto";
import { DataSource, EntityManager, QueryFailedError } from "typeorm";
import { DomainError } from "../common/domain-error";
import { InventoryService } from "../inventory/inventory.service";
import {
  Order,
  OrderKind,
  OrderPaymentSource,
  OrderStatus,
} from "../orders/entities/order.entity";
import {
  FulfillmentMethod,
  FulfillmentStatus,
  OrderFulfillment,
} from "../orders/entities/order-fulfillment.entity";
import { OrderItem } from "../orders/entities/order-item.entity";
import { Product } from "../products/entities/product.entity";
import { ProductVariant } from "../products/entities/product-variant.entity";
import { CreateManualStoreSaleDto } from "./admin-manual-store-sales.dto";
import { toAdminOrderItem } from "./admin-orders-payments.responses";
import { AdminAuditLog } from "./entities/admin-audit-log.entity";
import { AdminRole, AdminUser } from "./entities/admin-user.entity";

@Injectable()
export class AdminManualStoreSalesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly inventory: InventoryService,
  ) {}

  async create(dto: CreateManualStoreSaleDto, adminId: string) {
    const items = dto.items
      .map((item) => ({ variantId: item.variantId, quantity: item.quantity }))
      .sort((a, b) => a.variantId.localeCompare(b.variantId));
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          flow: "manual-store-sale",
          adminId,
          customer: {
            name: dto.customer.name,
            email: dto.customer.email ?? null,
            phone: dto.customer.phone ?? null,
          },
          paymentMethod: dto.paymentMethod,
          note: dto.note ?? null,
          items,
        }),
      )
      .digest("hex");

    try {
      return await this.dataSource.transaction(async (manager) => {
        const admin = await manager.findOneBy(AdminUser, {
          id: adminId,
          active: true,
          role: AdminRole.ADMIN,
        });
        if (!admin) throw new UnauthorizedException();
        // Repeated requests serialize before touching stock. Order's global
        // unique key also protects against collisions with other order flows.
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`store-manual-sale:${dto.idempotencyKey}`],
        );
        const existing = await manager.findOneBy(Order, {
          idempotencyKey: dto.idempotencyKey,
        });
        if (existing) return this.replay(manager, existing, fingerprint);

        const variantIds = items.map((item) => item.variantId);
        const initial = await manager
          .getRepository(ProductVariant)
          .createQueryBuilder("variant")
          .where("variant.id IN (:...variantIds)", { variantIds })
          .getMany();
        if (initial.length !== variantIds.length) {
          const missing = variantIds.find(
            (id) => !initial.some((variant) => variant.id === id),
          );
          throw new DomainError(
            "VARIANT_NOT_FOUND",
            "La variante no existe.",
            { variantId: missing },
            404,
          );
        }
        const productIds = [
          ...new Set(initial.map((variant) => variant.productId)),
        ].sort();
        // Same lock order as CheckoutService / InventoryService: all products,
        // then variants, then stock. Prices and sellability are read under lock.
        const products = await manager
          .getRepository(Product)
          .createQueryBuilder("product")
          .setLock("pessimistic_write")
          .where("product.id IN (:...productIds)", { productIds })
          .orderBy("product.id", "ASC")
          .getMany();
        const variants = await manager
          .getRepository(ProductVariant)
          .createQueryBuilder("variant")
          .setLock("pessimistic_write")
          .where("variant.id IN (:...variantIds)", { variantIds })
          .orderBy("variant.id", "ASC")
          .getMany();
        const productById = new Map(
          products.map((product) => [product.id, product]),
        );
        const variantById = new Map(
          variants.map((variant) => [variant.id, variant]),
        );
        const snapshots = items.map((item) => {
          const variant = variantById.get(item.variantId);
          if (!variant)
            throw new DomainError(
              "VARIANT_NOT_FOUND",
              "La variante no existe.",
              { variantId: item.variantId },
              404,
            );
          if (!variant.active)
            throw new DomainError(
              "VARIANT_INACTIVE",
              "La variante no está activa.",
              { variantId: variant.id },
            );
          const product = productById.get(variant.productId);
          if (!product?.active)
            throw new DomainError(
              "PRODUCT_INACTIVE",
              "El producto no está activo.",
              { variantId: variant.id },
            );
          return {
            variantId: variant.id,
            productNameSnapshot: product.name,
            variantNameSnapshot: variant.name,
            skuSnapshot: variant.sku,
            quantity: item.quantity,
            unitPriceInCents: variant.priceInCents,
            lineTotalInCents: variant.priceInCents * item.quantity,
          };
        });
        const total = snapshots.reduce(
          (sum, item) => sum + item.lineTotalInCents,
          0,
        );
        if (
          snapshots.some((item) => item.unitPriceInCents <= 0) ||
          !Number.isSafeInteger(total) ||
          total <= 0 ||
          total > 2_147_483_647
        ) {
          throw new DomainError(
            "INVALID_SALE_TOTAL",
            "El total de la venta supera el rango permitido o contiene un precio inválido.",
            undefined,
            400,
          );
        }

        const now = new Date();
        const order = await manager.save(Order, {
          kind: OrderKind.MERCH,
          status: OrderStatus.PAID,
          paymentSource: OrderPaymentSource.MANUAL,
          manualPaymentMethod: dto.paymentMethod,
          manualSaleNote: dto.note ?? null,
          idempotencyKey: dto.idempotencyKey,
          requestFingerprint: fingerprint,
          subtotalInCents: total,
          totalInCents: total,
          reservationExpiresAt: now,
          paidAt: now,
        });
        const savedItems = await manager.save(
          OrderItem,
          snapshots.map((item) => ({ ...item, orderId: order.id })),
        );
        for (const item of items) {
          await this.inventory.reserveStock(
            manager,
            item.variantId,
            item.quantity,
            order.id,
          );
          await this.inventory.commitSale(
            manager,
            item.variantId,
            item.quantity,
            order.id,
            "Manual store sale",
          );
        }
        const fulfillment = await manager.save(OrderFulfillment, {
          orderId: order.id,
          method: FulfillmentMethod.PICKUP,
          status: FulfillmentStatus.PENDING,
          customerName: dto.customer.name,
          customerEmail: dto.customer.email ?? null,
          customerPhone: dto.customer.phone ?? null,
          customerNote: null,
          adminNote: null,
          readyAt: null,
          completedAt: null,
        });
        await manager.save(AdminAuditLog, {
          adminUserId: adminId,
          action: "STORE_MANUAL_SALE_CREATED",
          entityType: "ORDER",
          entityId: order.id,
          metadata: {
            orderId: order.id,
            itemsCount: items.reduce((sum, item) => sum + item.quantity, 0),
            lineCount: items.length,
            totalInCents: total,
            paymentMethod: dto.paymentMethod,
            createdByAdminId: adminId,
          },
        });
        return this.response(order, savedItems, fulfillment);
      });
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        error.driverError?.code === "23505"
      ) {
        const existing = await this.dataSource
          .getRepository(Order)
          .findOneBy({ idempotencyKey: dto.idempotencyKey });
        if (existing)
          return this.replay(this.dataSource.manager, existing, fingerprint);
      }
      throw error;
    }
  }

  private async replay(
    manager: EntityManager,
    order: Order,
    fingerprint: string,
  ) {
    if (
      order.kind !== OrderKind.MERCH ||
      order.paymentSource !== OrderPaymentSource.MANUAL ||
      order.requestFingerprint !== fingerprint
    ) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "La clave de idempotencia ya fue utilizada para otra operación.",
      );
    }
    const [items, fulfillment] = await Promise.all([
      manager.find(OrderItem, {
        where: { orderId: order.id },
        order: { variantId: "ASC" },
      }),
      manager.findOneByOrFail(OrderFulfillment, { orderId: order.id }),
    ]);
    return this.response(order, items, fulfillment);
  }

  private response(
    order: Order,
    items: OrderItem[],
    fulfillment: OrderFulfillment,
  ) {
    return {
      orderId: order.id,
      kind: order.kind,
      status: order.status,
      paymentSource: order.paymentSource,
      paymentMethod: order.manualPaymentMethod,
      note: order.manualSaleNote,
      totalInCents: order.totalInCents,
      paidAt: order.paidAt,
      customer: {
        name: fulfillment.customerName,
        email: fulfillment.customerEmail,
        phone: fulfillment.customerPhone,
      },
      items: items.map((item) => ({
        variantId: item.variantId,
        ...toAdminOrderItem(item),
      })),
      fulfillment: {
        id: fulfillment.id,
        method: fulfillment.method,
        status: fulfillment.status,
      },
    };
  }
}
