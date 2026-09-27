import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource, EntityManager, In, QueryFailedError } from "typeorm";
import { DomainError } from "../common/domain-error";
import { Product } from "../products/entities/product.entity";
import { ProductVariant } from "../products/entities/product-variant.entity";
import { ProductMedia } from "../products/entities/product-media.entity";
import {
  attributesFingerprint,
  normalizeVariantAttributes,
  VariantAttributes,
} from "../products/variant-attributes";
import { Inventory } from "../inventory/entities/inventory.entity";
import {
  InventoryMovement,
  InventoryMovementType,
} from "../inventory/entities/inventory-movement.entity";
import { OrderItem } from "../orders/entities/order-item.entity";
import { AdminAuditLog } from "./entities/admin-audit-log.entity";
import {
  ProductDto,
  ProductListDto,
  ProductPatchDto,
  VariantDto,
  VariantPatchDto,
  MediaDto,
  MediaPatchDto,
} from "./admin-products.dto";

const notFound = (code: string, message: string) =>
  new NotFoundException({ code, message });
const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
@Injectable()
export class AdminProductsService {
  constructor(private readonly dataSource: DataSource) {}
  private audit(
    manager: ReturnType<DataSource["createEntityManager"]>,
    adminUserId: string,
    action: string,
    type: string,
    id: string,
  ) {
    return manager.save(AdminAuditLog, {
      adminUserId,
      action,
      entityType: type,
      entityId: id,
      metadata: null,
    });
  }
  private async unique<T>(fn: () => Promise<T>, code: string) {
    try {
      return await fn();
    } catch (e) {
      if (
        e instanceof QueryFailedError &&
        (e as { code?: string }).code === "23505" &&
        (e as { constraint?: string }).constraint === "UQ_variant_model_combination"
      )
        throw new DomainError(
          "VARIANT_ATTRIBUTE_COMBINATION_CONFLICT",
          "Ya existe una variante con el mismo modelo, color y talle.",
        );
      if (
        e instanceof QueryFailedError &&
        (e as { code?: string }).code === "23505"
      )
        throw new DomainError(
          code,
          code === "PRODUCT_SLUG_CONFLICT"
            ? "El slug ya existe."
            : "El SKU ya existe.",
        );
      throw e;
    }
  }
  private attributes(input: unknown): VariantAttributes {
    try {
      return normalizeVariantAttributes(input);
    } catch (error) {
      throw new DomainError(
        "INVALID_VARIANT_ATTRIBUTES",
        "Los atributos deben ser un objeto plano de strings no vacíos.",
        { reason: error instanceof Error ? error.message : "UNKNOWN" },
        400,
      );
    }
  }
  private async assertUniqueActiveAttributes(
    manager: ReturnType<DataSource["createEntityManager"]>,
    productId: string,
    attributes: VariantAttributes,
    active: boolean,
    excludeVariantId?: string,
  ) {
    const fingerprint = attributesFingerprint(attributes);
    if ((!active && !attributes.model) || !fingerprint) return;
    const variants = await manager.findBy(ProductVariant, {
      productId,
      ...(attributes.model ? {} : { active: true }),
    });
    const duplicate = variants.find(
      (variant) =>
        variant.id !== excludeVariantId &&
        (attributes.model
          ? ["model", "color", "size"].every(
              (key) => (attributes[key] ?? "").toLowerCase() ===
                (variant[key as "model" | "color" | "size"] ?? "").trim().toLowerCase(),
            )
          : attributesFingerprint(this.variantAttributes(variant.attributes ?? {}, variant)) === fingerprint),
    );
    if (duplicate)
      throw new DomainError(
        "VARIANT_ATTRIBUTE_COMBINATION_CONFLICT",
        "Ya existe una variante activa con la misma combinación de atributos.",
      );
  }
  private variantAttributes(
    input: unknown,
    dimensions: { model?: string | null; color?: string | null; size?: string | null },
  ): VariantAttributes {
    const attributes = this.attributes(input);
    for (const key of ["model", "color", "size"] as const) {
      if (dimensions[key] === undefined) continue;
      const value = dimensions[key]?.trim().replace(/\s+/g, " ") || null;
      if (value) attributes[key] = value;
      else delete attributes[key];
    }
    return this.attributes(attributes);
  }
  async list(query: ProductListDto) {
    const page = query.page ?? 1,
      pageSize = query.pageSize ?? 20;
    const base = this.dataSource
      .getRepository(Product)
      .createQueryBuilder("product");
    if (query.search)
      base.andWhere(
        "(product.name ILIKE :search OR product.slug ILIKE :search)",
        { search: `%${query.search.trim()}%` },
      );
    if (query.active !== undefined)
      base.andWhere("product.active = :active", { active: query.active });
    const fields: Record<string, string> = {
      name: "product.name",
      createdAt: "product.createdAt",
      sortOrder: "product.sortOrder",
    };
    const [field, dir] = (query.sort ?? "sortOrder:asc").split(":");
    const direction = dir?.toUpperCase() === "DESC" ? "DESC" : "ASC";
    const sortExpression = fields[field] ?? fields.sortOrder;
    const total = await base.clone().getCount();
    const pageQuery = base
      .clone()
      .select("product.id", "id")
      .orderBy(sortExpression, direction);

    if (sortExpression !== "product.name") {
      pageQuery.addOrderBy("product.name", "ASC");
    }

    const rows = await pageQuery
      .addOrderBy("product.id", "ASC")
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getRawMany<{ id: string }>();
    const ids = rows.map((row) => row.id);
    const products = ids.length
      ? await this.dataSource.getRepository(Product).find({
          where: { id: In(ids) },
          relations: { variants: true, media: true },
        })
      : [];
    const byId = new Map(products.map((product) => [product.id, product]));
    return {
      items: ids.map((id) => byId.get(id)!).filter(Boolean),
      page,
      pageSize,
      total,
    };
  }
  async product(id: string) {
    const p = await this.dataSource
      .getRepository(Product)
      .findOne({ where: { id }, relations: { variants: true, media: true } });
    if (!p) throw notFound("PRODUCT_NOT_FOUND", "El producto no existe.");
    return p;
  }
  async createProduct(dto: ProductDto, adminId: string) {
    const slug = slugify(dto.slug);
    if (!slug)
      throw new DomainError("INVALID_SLUG", "Slug inválido.", undefined, 400);
    return this.unique(
      () =>
        this.dataSource.transaction(async (m) => {
          const p = await m.save(Product, {
            name: dto.name.trim(),
            slug,
            shortDescription: dto.shortDescription?.trim() ?? null,
            active: dto.active ?? true,
            featured: dto.featured ?? false,
            sortOrder: dto.sortOrder ?? 0,
          });
          await this.audit(m, adminId, "PRODUCT_CREATED", "PRODUCT", p.id);
          return p;
        }),
      "PRODUCT_SLUG_CONFLICT",
    );
  }
  async updateProduct(id: string, dto: ProductPatchDto, adminId: string) {
    return this.unique(
      () =>
        this.dataSource.transaction(async (m) => {
          const p = await m
            .getRepository(Product)
            .createQueryBuilder("product")
            .setLock("pessimistic_write")
            .where("product.id = :id", { id })
            .getOne();
          if (!p) throw notFound("PRODUCT_NOT_FOUND", "El producto no existe.");
          const wasActive = p.active;
          if (dto.slug !== undefined) {
            const slug = slugify(dto.slug);
            if (!slug)
              throw new DomainError(
                "INVALID_SLUG",
                "Slug inválido.",
                undefined,
                400,
              );
            p.slug = slug;
          }
          if (dto.name !== undefined) p.name = dto.name.trim();
          if (dto.shortDescription !== undefined)
            p.shortDescription = dto.shortDescription?.trim() || null;
          if (dto.active !== undefined) p.active = dto.active;
          if (dto.featured !== undefined) p.featured = dto.featured;
          if (dto.sortOrder !== undefined) p.sortOrder = dto.sortOrder;
          await m.save(p);
          await this.audit(
            m,
            adminId,
            dto.active !== undefined && dto.active !== wasActive
              ? dto.active
                ? "PRODUCT_ACTIVATED"
                : "PRODUCT_DEACTIVATED"
              : "PRODUCT_UPDATED",
            "PRODUCT",
            p.id,
          );
          return p;
        }),
      "PRODUCT_SLUG_CONFLICT",
    );
  }
  private async variantHasHistory(manager: EntityManager, variantId: string) {
    const [hasOrderItems, hasMovements, inventory] = await Promise.all([
      manager.existsBy(OrderItem, { variantId }),
      manager.existsBy(InventoryMovement, { variantId }),
      manager.findOneBy(Inventory, { variantId }),
    ]);
    return hasOrderItems || hasMovements || (inventory?.reservedStock ?? 0) > 0;
  }
  private async deactivateProductWithoutActiveVariants(
    manager: EntityManager,
    product: Product,
    adminId: string,
  ) {
    if (
      product.active &&
      !(await manager.existsBy(ProductVariant, {
        productId: product.id,
        active: true,
      }))
    ) {
      product.active = false;
      await manager.save(product);
      await this.audit(
        manager,
        adminId,
        "PRODUCT_DEACTIVATED_NO_ACTIVE_VARIANTS",
        "PRODUCT",
        product.id,
      );
    }
  }
  async removeProduct(id: string, adminId: string) {
    return this.dataSource.transaction(async (manager) => {
      const product = await manager
        .getRepository(Product)
        .createQueryBuilder("product")
        .setLock("pessimistic_write")
        .where("product.id = :id", { id })
        .getOne();
      if (!product) throw notFound("PRODUCT_NOT_FOUND", "El producto no existe.");
      const productId = product.id;
      const variants = await manager
        .getRepository(ProductVariant)
        .createQueryBuilder("variant")
        .setLock("pessimistic_write")
        .where("variant.product_id = :id", { id })
        .getMany();
      const hasHistory = (
        await Promise.all(
          variants.map((variant) => this.variantHasHistory(manager, variant.id)),
        )
      ).some(Boolean);
      if (hasHistory) {
        product.active = false;
        await manager.save(product);
        for (const variant of variants.filter((variant) => variant.active)) {
          variant.active = false;
          await manager.save(variant);
          await this.audit(manager, adminId, "VARIANT_ARCHIVED", "VARIANT", variant.id);
        }
        await this.audit(manager, adminId, "PRODUCT_ARCHIVED", "PRODUCT", product.id);
        return { result: "ARCHIVED" as const };
      }
      const variantIds = variants.map((variant) => variant.id);
      await manager.delete(ProductMedia, { productId: product.id });
      if (variantIds.length) {
        await manager.delete(Inventory, { variantId: In(variantIds) });
        await manager.remove(variants);
      }
      await manager.remove(product);
      await this.audit(manager, adminId, "PRODUCT_DELETED", "PRODUCT", productId);
      return { result: "DELETED" as const };
    });
  }
  async removeVariant(id: string, adminId: string) {
    return this.dataSource.transaction(async (manager) => {
      // Product is locked first, matching checkout and product deletion lock order.
      const candidate = await manager.findOneBy(ProductVariant, { id });
      if (!candidate) throw notFound("VARIANT_NOT_FOUND", "La variante no existe.");
      const product = await manager
        .getRepository(Product)
        .createQueryBuilder("product")
        .setLock("pessimistic_write")
        .where("product.id = :productId", { productId: candidate.productId })
        .getOneOrFail();
      const variant = await manager
        .getRepository(ProductVariant)
        .createQueryBuilder("variant")
        .setLock("pessimistic_write")
        .where("variant.id = :id", { id })
        .getOne();
      if (!variant) throw notFound("VARIANT_NOT_FOUND", "La variante no existe.");
      if (await this.variantHasHistory(manager, variant.id)) {
        if (variant.active) {
          variant.active = false;
          await manager.save(variant);
        }
        await this.deactivateProductWithoutActiveVariants(manager, product, adminId);
        await this.audit(manager, adminId, "VARIANT_ARCHIVED", "VARIANT", variant.id);
        return { result: "ARCHIVED" as const };
      }
      await manager.delete(ProductMedia, { productId: variant.productId, variantId: variant.id });
      await manager.delete(Inventory, { variantId: variant.id });
      const wasActive = variant.active;
      await manager.remove(variant);
      if (wasActive)
        await this.deactivateProductWithoutActiveVariants(manager, product, adminId);
      await this.audit(manager, adminId, "VARIANT_DELETED", "VARIANT", id);
      return { result: "DELETED" as const };
    });
  }
  async createVariant(productId: string, dto: VariantDto, adminId: string) {
    return this.unique(
      () =>
        this.dataSource.transaction(async (m) => {
          if (
            !(await m.getRepository(Product).createQueryBuilder("product")
              .setLock("pessimistic_write")
              .where("product.id = :productId", { productId })
              .getOne())
          )
            throw notFound("PRODUCT_NOT_FOUND", "El producto no existe.");
          const attributes =
            this.variantAttributes(dto.attributes ?? {}, dto);
          await this.assertUniqueActiveAttributes(
            m,
            productId,
            attributes,
            dto.active ?? true,
          );
          const v = await m.save(ProductVariant, {
            productId,
            sku: dto.sku.trim().toUpperCase(),
            name: dto.name.trim(),
            model: attributes.model ?? null,
            color: attributes.color ?? null,
            size: attributes.size ?? null,
            attributes,
            priceInCents: dto.priceInCents,
            active: dto.active ?? true,
            sortOrder: dto.sortOrder ?? 0,
            lowStockThreshold: dto.lowStockThreshold ?? null,
          });
          const initialStock = dto.initialStock ?? 0;
          await m.save(Inventory, {
            variantId: v.id,
            stockOnHand: initialStock,
            reservedStock: 0,
          });
          if (initialStock > 0)
            await m.save(InventoryMovement, {
              variantId: v.id,
              orderId: null,
              type: InventoryMovementType.RESTOCK,
              onHandDelta: initialStock,
              reservedDelta: 0,
              reason: "Initial stock",
            });
          await this.audit(m, adminId, "VARIANT_CREATED", "VARIANT", v.id);
          return v;
        }),
      "SKU_ALREADY_EXISTS",
    );
  }
  async variant(id: string) {
    const v = await this.dataSource
      .getRepository(ProductVariant)
      .findOneBy({ id });
    if (!v) throw notFound("VARIANT_NOT_FOUND", "La variante no existe.");
    return v;
  }
  async updateVariant(id: string, dto: VariantPatchDto, adminId: string) {
    return this.unique(
      () =>
        this.dataSource.transaction(async (m) => {
          const candidate = await m.findOneBy(ProductVariant, { id });
          if (!candidate) throw notFound("VARIANT_NOT_FOUND", "La variante no existe.");
          const product = await m
            .getRepository(Product)
            .createQueryBuilder("product")
            .setLock("pessimistic_write")
            .where("product.id = :productId", { productId: candidate.productId })
            .getOneOrFail();
          const v = await m
            .getRepository(ProductVariant)
            .createQueryBuilder("variant")
            .setLock("pessimistic_write")
            .where("variant.id = :id", { id })
            .getOne();
          if (!v) throw notFound("VARIANT_NOT_FOUND", "La variante no existe.");
          const wasActive = v.active;
          const attributes =
            dto.attributes !== undefined
              ? this.attributes(dto.attributes)
              : this.variantAttributes(v.attributes ?? {}, v);
          const normalizedAttributes = this.variantAttributes(attributes, dto);
          const usesStructuredAttributes =
            dto.attributes !== undefined ||
            dto.model !== undefined ||
            dto.color !== undefined ||
            dto.size !== undefined;
          await this.assertUniqueActiveAttributes(
            m,
            v.productId,
            normalizedAttributes,
            dto.active ?? v.active,
            v.id,
          );
          Object.assign(v, {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.sku !== undefined
              ? { sku: dto.sku.trim().toUpperCase() }
              : {}),
            ...(usesStructuredAttributes
              ? {
                  model: normalizedAttributes.model ?? null,
                  color: normalizedAttributes.color ?? null,
                  size: normalizedAttributes.size ?? null,
                  attributes: normalizedAttributes,
                }
              : {}),
            ...(dto.priceInCents !== undefined
              ? { priceInCents: dto.priceInCents }
              : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
            ...(dto.sortOrder !== undefined
              ? { sortOrder: dto.sortOrder }
              : {}),
            ...(dto.lowStockThreshold !== undefined
              ? { lowStockThreshold: dto.lowStockThreshold }
              : {}),
          });
          await m.save(v);
          await this.audit(
            m,
            adminId,
            dto.active !== undefined && dto.active !== wasActive
              ? dto.active
                ? "VARIANT_ACTIVATED"
                : "VARIANT_DEACTIVATED"
              : "VARIANT_UPDATED",
            "VARIANT",
            v.id,
          );
          return v;
        }),
      "SKU_ALREADY_EXISTS",
    );
  }
  async addMedia(productId: string, dto: MediaDto, adminId: string) {
    return this.dataSource.transaction(async (m) => {
      if (!(await m.existsBy(Product, { id: productId })))
        throw notFound("PRODUCT_NOT_FOUND", "El producto no existe.");
      const variantId = dto.variantId ?? null;
      if (
        variantId &&
        !(await m.existsBy(ProductVariant, { id: variantId, productId }))
      )
        throw new DomainError(
          "VARIANT_NOT_BELONG_TO_PRODUCT",
          "La variante no pertenece al producto.",
          undefined,
          409,
        );
      if (dto.isCover)
        await m
          .createQueryBuilder()
          .update(ProductMedia)
          .set({ isCover: false })
          .where(
            "product_id = :productId AND variant_id IS NOT DISTINCT FROM :variantId",
            { productId, variantId },
          )
          .execute();
      const media = await m.save(ProductMedia, {
        productId,
        variantId,
        url: dto.url,
        alt: dto.alt.trim(),
        sortOrder: dto.sortOrder ?? 0,
        isCover: dto.isCover ?? false,
      });
      await this.audit(
        m,
        adminId,
        "PRODUCT_MEDIA_CREATED",
        "PRODUCT_MEDIA",
        media.id,
      );
      return media;
    });
  }
  async updateMedia(id: string, dto: MediaPatchDto, adminId: string) {
    return this.dataSource.transaction(async (m) => {
      const media = await m.findOneBy(ProductMedia, { id });
      if (!media)
        throw notFound("PRODUCT_MEDIA_NOT_FOUND", "El recurso no existe.");
      const variantId =
        dto.variantId === undefined ? media.variantId : dto.variantId;
      if (
        variantId &&
        !(await m.existsBy(ProductVariant, {
          id: variantId,
          productId: media.productId,
        }))
      )
        throw new DomainError(
          "VARIANT_NOT_BELONG_TO_PRODUCT",
          "La variante no pertenece al producto.",
          undefined,
          409,
        );
      if (dto.isCover)
        await m
          .createQueryBuilder()
          .update(ProductMedia)
          .set({ isCover: false })
          .where(
            "product_id = :productId AND variant_id IS NOT DISTINCT FROM :variantId",
            { productId: media.productId, variantId },
          )
          .execute();
      Object.assign(media, {
        ...(dto.url !== undefined ? { url: dto.url } : {}),
        ...(dto.alt !== undefined ? { alt: dto.alt.trim() } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isCover !== undefined ? { isCover: dto.isCover } : {}),
        ...(dto.variantId !== undefined ? { variantId: dto.variantId } : {}),
      });
      await m.save(media);
      await this.audit(
        m,
        adminId,
        "PRODUCT_MEDIA_UPDATED",
        "PRODUCT_MEDIA",
        media.id,
      );
      return media;
    });
  }
  async removeMedia(id: string, adminId: string) {
    return this.dataSource.transaction(async (m) => {
      const media = await m.findOneBy(ProductMedia, { id });
      if (!media)
        throw notFound("PRODUCT_MEDIA_NOT_FOUND", "El recurso no existe.");
      await m.remove(media);
      await this.audit(
        m,
        adminId,
        "PRODUCT_MEDIA_DELETED",
        "PRODUCT_MEDIA",
        id,
      );
    });
  }
}
