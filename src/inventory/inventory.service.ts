import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { DomainError } from "../common/domain-error";
import { Inventory } from "./entities/inventory.entity";
import { ProductVariant } from "../products/entities/product-variant.entity";
import { Product } from "../products/entities/product.entity";
import {
  InventoryMovement,
  InventoryMovementType,
} from "./entities/inventory-movement.entity";

@Injectable()
export class InventoryService {
  constructor(private readonly dataSource: DataSource) {}
  async reserveStock(
    manager: EntityManager,
    variantId: string,
    quantity: number,
    orderId: string,
  ): Promise<void> {
    await this.lockInventoryMutation(manager, variantId);
    const result = await manager
      .createQueryBuilder()
      .update(Inventory)
      .set({ reservedStock: () => `reserved_stock + ${quantity}` })
      .where(
        "variant_id = :variantId AND stock_on_hand - reserved_stock >= :quantity",
        { variantId, quantity },
      )
      .execute();
    if (result.affected !== 1) {
      const inventory = await manager.findOneBy(Inventory, { variantId });
      throw new DomainError(
        "OUT_OF_STOCK",
        "No hay stock suficiente para una de las variantes solicitadas.",
        {
          variantId,
          requested: quantity,
          available: inventory
            ? inventory.stockOnHand - inventory.reservedStock
            : 0,
        },
      );
    }
    await manager.save(InventoryMovement, {
      variantId,
      orderId,
      type: InventoryMovementType.RESERVE,
      onHandDelta: 0,
      reservedDelta: quantity,
      reason: null,
    });
  }

  /**
   *
   * @param manager
   * @param variantId
   * @param quantity
   * @param orderId
   * @param reason
   */
  async releaseReservation(
    manager: EntityManager,
    variantId: string,
    quantity: number,
    orderId: string,
    reason = "Reservation expired",
  ): Promise<void> {
    await this.lockInventoryMutation(manager, variantId);
    const result = await manager
      .createQueryBuilder()
      .update(Inventory)
      .set({ reservedStock: () => `reserved_stock - ${quantity}` })
      .where("variant_id = :variantId AND reserved_stock >= :quantity", {
        variantId,
        quantity,
      })
      .execute();
    if (result.affected !== 1)
      throw new Error(
        `Inventory reservation invariant violated for ${variantId}`,
      );
    await manager.save(InventoryMovement, {
      variantId,
      orderId,
      type: InventoryMovementType.RELEASE,
      onHandDelta: 0,
      reservedDelta: -quantity,
      reason,
    });
  }

  async commitSale(
    manager: EntityManager,
    variantId: string,
    quantity: number,
    orderId: string,
    reason = "Mercado Pago approved payment",
  ): Promise<void> {
    await this.lockInventoryMutation(manager, variantId);
    const result = await manager
      .createQueryBuilder()
      .update(Inventory)
      .set({
        stockOnHand: () => `stock_on_hand - ${quantity}`,
        reservedStock: () => `reserved_stock - ${quantity}`,
      })
      .where(
        "variant_id = :variantId AND stock_on_hand >= :quantity AND reserved_stock >= :quantity",
        { variantId, quantity },
      )
      .execute();
    if (result.affected !== 1)
      throw new Error(`Inventory sale invariant violated for ${variantId}`);
    await manager.save(InventoryMovement, {
      variantId,
      orderId,
      type: InventoryMovementType.SALE,
      onHandDelta: -quantity,
      reservedDelta: -quantity,
      reason,
    });
  }

  /**
   *
   * @param variantId
   * @param quantity
   * @param reason
   */
  async restock(
    variantId: string,
    quantity: number,
    reason: string,
  ): Promise<void> {
    if (!Number.isInteger(quantity) || quantity <= 0)
      throw new DomainError(
        "INVALID_STOCK_ADJUSTMENT",
        "La reposición debe ser un entero positivo.",
        undefined,
        400,
      );
    await this.inTransaction(async (manager) => {
      await this.lockInventoryMutation(manager, variantId);
      const result = await manager
        .createQueryBuilder()
        .update(Inventory)
        .set({ stockOnHand: () => `stock_on_hand + ${quantity}` })
        .where("variant_id = :variantId", { variantId })
        .execute();
      if (result.affected !== 1)
        throw new DomainError(
          "VARIANT_NOT_FOUND",
          "La variante no existe.",
          { variantId },
          404,
        );
      await manager.save(InventoryMovement, {
        variantId,
        orderId: null,
        type: InventoryMovementType.RESTOCK,
        onHandDelta: quantity,
        reservedDelta: 0,
        reason,
      });
    });
  }

  // Internal-only foundation for future authenticated admin operations.
  async adjustStock(
    variantId: string,
    quantityDelta: number,
    reason: string,
  ): Promise<void> {
    if (
      !reason?.trim() ||
      !Number.isInteger(quantityDelta) ||
      quantityDelta === 0
    )
      throw new DomainError(
        "INVALID_STOCK_ADJUSTMENT",
        "El ajuste requiere cantidad entera distinta de cero y motivo.",
        undefined,
        400,
      );
    await this.inTransaction(async (manager) => {
      await this.lockInventoryMutation(manager, variantId);
      const result = await manager
        .createQueryBuilder()
        .update(Inventory)
        .set({ stockOnHand: () => `stock_on_hand + ${quantityDelta}` })
        .where(
          "variant_id = :variantId AND stock_on_hand + :delta >= reserved_stock",
          { variantId, delta: quantityDelta },
        )
        .execute();
      if (result.affected !== 1)
        throw new DomainError(
          "INVALID_STOCK_ADJUSTMENT",
          "El ajuste dejaría stock por debajo de lo reservado.",
          { variantId },
        );
      await manager.save(InventoryMovement, {
        variantId,
        orderId: null,
        type: InventoryMovementType.ADJUSTMENT,
        onHandDelta: quantityDelta,
        reservedDelta: 0,
        reason,
      });
    });
  }

  /**
   * All inventory mutations acquire locks in the same order. This prevents a
   * checkout/payment/expiration transaction (which may already hold the
   * order lock) from deadlocking with an admin adjustment or product change.
   */
  private async lockInventoryMutation(
    manager: EntityManager,
    variantId: string,
  ): Promise<void> {
    const variant = await manager.findOneBy(ProductVariant, { id: variantId });
    if (!variant) return;

    await manager
      .createQueryBuilder(Product, "product")
      .setLock("pessimistic_write")
      .where("product.id = :productId", { productId: variant.productId })
      .getOne();

    await manager
      .createQueryBuilder(ProductVariant, "variant")
      .setLock("pessimistic_write")
      .where("variant.id = :variantId", { variantId })
      .getOne();

    await manager
      .createQueryBuilder(Inventory, "inventory")
      .setLock("pessimistic_write")
      .where("inventory.variant_id = :variantId", { variantId })
      .getOne();
  }

  private async inTransaction<T>(
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(operation);
  }
}
