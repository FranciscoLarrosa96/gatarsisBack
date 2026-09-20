import { Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "crypto";
import { DataSource, EntityManager, In, QueryFailedError } from "typeorm";
import { AdminAuditLog } from "../admin/entities/admin-audit-log.entity";
import { DomainError } from "../common/domain-error";
import {
  Order,
  OrderKind,
  OrderPaymentSource,
  OrderStatus,
} from "../orders/entities/order.entity";
import {
  Payment,
  PaymentProcessingStatus,
} from "../payments/entities/payment.entity";
import { PaymentPreference } from "../payments/entities/payment-preference.entity";
import { RefundOperation } from "../payments/entities/refund-operation.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "./entities/raffle-number.entity";
import { Raffle, RaffleStatus } from "./entities/raffle.entity";
import { RafflePurchase } from "./entities/raffle-purchase.entity";
import {
  CreateManualRaffleSaleDto,
  CreateRaffleDto,
  RaffleListDto,
  RafflePurchasesListDto,
  UpdateRaffleDto,
} from "./raffles.dto";
import { raffleReservationConfig } from "./raffle.config";

type NumberSummaryRow = {
  total: string;
  available: string;
  reserved: string;
  sold: string;
};

type FinancialSummaryRow = {
  paidPurchases: string;
  activeReservations: string;
  revenueInCents: string;
};

@Injectable()
export class RafflesService {
  constructor(private readonly dataSource: DataSource) {}

  private imageUrl(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value === "") return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || !parsed.hostname)
        throw new Error("HTTPS_REQUIRED");
      return parsed.toString();
    } catch {
      throw new DomainError(
        "RAFFLE_INVALID_IMAGE_URL",
        "La imagen debe ser una URL HTTPS válida.",
        undefined,
        400,
      );
    }
  }

  private audit(
    manager: EntityManager,
    adminId: string,
    action:
      | "RAFFLE_CREATED"
      | "RAFFLE_UPDATED"
      | "RAFFLE_ACTIVATED"
      | "RAFFLE_PAUSED"
      | "RAFFLE_RESUMED"
      | "RAFFLE_CLOSED"
      | "RAFFLE_DRAWN"
      | "manual_raffle_sale_created",
    raffleId: string,
    metadata: Record<string, unknown>,
  ) {
    return manager.save(AdminAuditLog, {
      adminUserId: adminId,
      action,
      entityType: "RAFFLE",
      entityId: raffleId,
      metadata,
    });
  }

  async create(dto: CreateRaffleDto, adminId: string) {
    return this.dataSource.transaction(async (manager) => {
      const raffle = await manager.save(Raffle, {
        title: dto.title,
        prizeName: dto.prizeName,
        description: dto.description || null,
        imageUrl: this.imageUrl(dto.imageUrl),
        priceInCents: dto.priceInCents,
        status: RaffleStatus.DRAFT,
        drawAt: dto.drawAt ? new Date(dto.drawAt) : null,
        winningNumber: null,
        drawnAt: null,
        drawnByAdminId: null,
      });
      await manager.insert(
        RaffleNumber,
        Array.from({ length: 100 }, (_, number) => ({
          raffleId: raffle.id,
          number,
          status: RaffleNumberStatus.AVAILABLE,
          rafflePurchaseId: null,
          reservedUntil: null,
          reservedAt: null,
          soldAt: null,
        })),
      );
      await this.audit(manager, adminId, "RAFFLE_CREATED", raffle.id, {
        numberCount: 100,
      });
      return raffle;
    });
  }

  async manualSale(
    raffleId: string,
    dto: CreateManualRaffleSaleDto,
    adminId: string,
  ) {
    const numbers = [...dto.numbers].sort((a, b) => a - b);
    if (numbers.length > raffleReservationConfig().maxNumbersPerPurchase)
      throw new DomainError(
        "RAFFLE_TOO_MANY_NUMBERS",
        "La cantidad de números supera el máximo permitido por compra.",
        undefined,
        400,
      );

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          raffleId,
          numbers,
          buyer: {
            name: dto.buyer.name,
            email: dto.buyer.email ?? null,
            whatsapp: dto.buyer.whatsapp ?? null,
          },
          paymentMethod: dto.paymentMethod,
          note: dto.note ?? null,
        }),
      )
      .digest("hex");
    const existing = await this.dataSource
      .getRepository(Order)
      .findOneBy({ idempotencyKey: dto.idempotencyKey });
    if (existing)
      return this.manualSaleResponseOrConflict(existing, raffleId, fingerprint);

    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`raffle-manual-sale:${dto.idempotencyKey}`],
        );
        const duplicate = await manager.findOneBy(Order, {
          idempotencyKey: dto.idempotencyKey,
        });
        if (duplicate)
          return this.manualSaleResponseOrConflict(
            duplicate,
            raffleId,
            fingerprint,
            manager,
          );

        const raffle = await this.lockRaffle(manager, raffleId);
        if (raffle.status !== RaffleStatus.ACTIVE)
          throw new DomainError(
            "RAFFLE_NOT_ACTIVE",
            "La rifa no está activa.",
            undefined,
            409,
          );

        const selected = await manager
          .getRepository(RaffleNumber)
          .createQueryBuilder("number")
          .setLock("pessimistic_write")
          .where("number.raffle_id = :raffleId", { raffleId })
          .andWhere("number.number IN (:...numbers)", { numbers })
          .orderBy("number.number", "ASC")
          .getMany();
        const allAvailable =
          selected.length === numbers.length &&
          selected.every(
            (number, index) =>
              number.number === numbers[index] &&
              number.status === RaffleNumberStatus.AVAILABLE &&
              number.rafflePurchaseId === null,
          );
        if (!allAvailable)
          throw new DomainError(
            "RAFFLE_NUMBER_UNAVAILABLE",
            "Uno o más números ya no están disponibles.",
            undefined,
            409,
          );

        const now = new Date();
        const totalInCents = raffle.priceInCents * numbers.length;
        const order = await manager.save(Order, {
          kind: OrderKind.RAFFLE,
          status: OrderStatus.PAID,
          paymentSource: OrderPaymentSource.MANUAL,
          idempotencyKey: dto.idempotencyKey,
          requestFingerprint: fingerprint,
          subtotalInCents: totalInCents,
          totalInCents,
          reservationExpiresAt: now,
          paidAt: now,
        });
        const purchase = await manager.save(RafflePurchase, {
          raffleId,
          orderId: order.id,
          buyerName: dto.buyer.name,
          buyerEmail: dto.buyer.email ?? null,
          buyerPhone: dto.buyer.whatsapp ?? null,
          unitPriceInCents: raffle.priceInCents,
          manualPaymentMethod: dto.paymentMethod,
          manualPaymentNote: dto.note ?? null,
        });
        for (const raffleNumber of selected) {
          raffleNumber.status = RaffleNumberStatus.SOLD;
          raffleNumber.rafflePurchaseId = purchase.id;
          raffleNumber.reservedAt = null;
          raffleNumber.reservedUntil = null;
          raffleNumber.soldAt = now;
        }
        await manager.save(selected);
        await this.audit(
          manager,
          adminId,
          "manual_raffle_sale_created",
          raffleId,
          {
            raffleId,
            rafflePurchaseId: purchase.id,
            orderId: order.id,
            numbers,
            amountInCents: totalInCents,
            paymentMethod: dto.paymentMethod,
          },
        );
        return this.manualSaleView(order, purchase, numbers);
      });
    } catch (error) {
      const driverError = (
        error as { driverError?: { code?: string; constraint?: string } }
      ).driverError;
      if (
        error instanceof QueryFailedError &&
        driverError?.code === "23505"
      ) {
        const raced = await this.dataSource
          .getRepository(Order)
          .findOneBy({ idempotencyKey: dto.idempotencyKey });
        if (raced)
          return this.manualSaleResponseOrConflict(
            raced,
            raffleId,
            fingerprint,
          );
      }
      throw error;
    }
  }

  async list(query: RaffleListDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [items, total] = await this.dataSource
      .getRepository(Raffle)
      .findAndCount({
        select: {
          id: true,
          title: true,
          prizeName: true,
          imageUrl: true,
          priceInCents: true,
          status: true,
          drawAt: true,
          createdAt: true,
          updatedAt: true,
        },
        order: { createdAt: "DESC", id: "ASC" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
    return { items, page, pageSize, total };
  }

  async detail(id: string) {
    const raffle = await this.dataSource
      .getRepository(Raffle)
      .findOneBy({ id });
    if (!raffle)
      throw new NotFoundException({
        code: "RAFFLE_NOT_FOUND",
        message: "La rifa no existe.",
      });
    const summary = await this.dataSource
      .getRepository(RaffleNumber)
      .createQueryBuilder("number")
      .select("COUNT(*)", "total")
      .addSelect(
        `COUNT(*) FILTER (WHERE number.status = '${RaffleNumberStatus.AVAILABLE}')`,
        "available",
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE number.status = '${RaffleNumberStatus.RESERVED}')`,
        "reserved",
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE number.status = '${RaffleNumberStatus.SOLD}')`,
        "sold",
      )
      .where("number.raffleId = :id", { id })
      .getRawOne<NumberSummaryRow>();
    const financial = await this.dataSource
      .getRepository(RafflePurchase)
      .createQueryBuilder("purchase")
      .innerJoin(Order, "order", "order.id = purchase.order_id")
      .select(
        `COUNT(*) FILTER (WHERE order.status = '${OrderStatus.PAID}')`,
        "paidPurchases",
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE order.status IN ('${OrderStatus.AWAITING_PAYMENT}', '${OrderStatus.PAYMENT_PENDING}') AND order.reservation_expires_at > NOW())`,
        "activeReservations",
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN order.status = '${OrderStatus.PAID}' THEN order.total_in_cents ELSE 0 END), 0)`,
        "revenueInCents",
      )
      .where("purchase.raffle_id = :id", { id })
      .getRawOne<FinancialSummaryRow>();
    const history = await this.dataSource.getRepository(AdminAuditLog).find({
      where: { entityType: "RAFFLE", entityId: id },
      select: {
        id: true,
        adminUserId: true,
        action: true,
        metadata: true,
        createdAt: true,
      },
      order: { createdAt: "DESC" },
      take: 100,
    });
    const counts = {
      totalNumbers: Number(summary?.total ?? 0),
      available: Number(summary?.available ?? 0),
      reserved: Number(summary?.reserved ?? 0),
      sold: Number(summary?.sold ?? 0),
      paidPurchases: Number(financial?.paidPurchases ?? 0),
      activeReservations: Number(financial?.activeReservations ?? 0),
      revenueInCents: Number(financial?.revenueInCents ?? 0),
    };
    return {
      ...raffle,
      numberSummary: {
        total: counts.totalNumbers,
        available: counts.available,
        reserved: counts.reserved,
        sold: counts.sold,
      },
      stats: counts,
      history,
    };
  }

  async update(id: string, dto: UpdateRaffleDto, adminId: string) {
    return this.dataSource.transaction(async (manager) => {
      const raffle = await manager
        .getRepository(Raffle)
        .createQueryBuilder("raffle")
        .setLock("pessimistic_write")
        .where("raffle.id = :id", { id })
        .getOne();
      if (!raffle)
        throw new NotFoundException({
          code: "RAFFLE_NOT_FOUND",
          message: "La rifa no existe.",
        });
      if (raffle.status !== RaffleStatus.DRAFT)
        throw new DomainError(
          "RAFFLE_EDIT_NOT_ALLOWED",
          "Sólo se puede editar una rifa en borrador.",
        );

      const changedFields = (
        [
          "title",
          "prizeName",
          "description",
          "imageUrl",
          "priceInCents",
          "drawAt",
        ] as const
      ).filter((field) => dto[field] !== undefined);
      if (dto.title !== undefined) raffle.title = dto.title;
      if (dto.prizeName !== undefined) raffle.prizeName = dto.prizeName;
      if (dto.description !== undefined)
        raffle.description = dto.description || null;
      if (dto.imageUrl !== undefined)
        raffle.imageUrl = this.imageUrl(dto.imageUrl);
      if (dto.priceInCents !== undefined)
        raffle.priceInCents = dto.priceInCents;
      if (dto.drawAt !== undefined)
        raffle.drawAt = dto.drawAt ? new Date(dto.drawAt) : null;

      if (changedFields.length) {
        await manager.save(raffle);
        await this.audit(manager, adminId, "RAFFLE_UPDATED", raffle.id, {
          changedFields,
        });
      }
      return raffle;
    });
  }

  async publish(id: string, adminId: string) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const raffle = await this.lockRaffle(manager, id);
        if (raffle.status !== RaffleStatus.DRAFT)
          throw new DomainError(
            "RAFFLE_PUBLISH_NOT_ALLOWED",
            "La rifa no puede publicarse desde su estado actual.",
          );
        const numbers = await manager
          .getRepository(RaffleNumber)
          .createQueryBuilder("number")
          .setLock("pessimistic_write")
          .where("number.raffle_id = :id", { id })
          .orderBy("number.number", "ASC")
          .getMany();
        const completeGrid =
          numbers.length === 100 &&
          numbers.every(
            (number, index) =>
              number.number === index &&
              number.status === RaffleNumberStatus.AVAILABLE &&
              number.rafflePurchaseId === null,
          );
        const purchaseCount = await manager.countBy(RafflePurchase, {
          raffleId: id,
        });
        if (
          !completeGrid ||
          purchaseCount !== 0 ||
          raffle.priceInCents <= 0 ||
          !raffle.title.trim() ||
          !raffle.prizeName.trim()
        )
          throw new DomainError(
            "RAFFLE_PUBLISH_NOT_ALLOWED",
            "La rifa no cumple las condiciones para publicarse.",
          );
        if (raffle.imageUrl) this.imageUrl(raffle.imageUrl);
        return this.applyTransition(
          manager,
          raffle,
          RaffleStatus.ACTIVE,
          adminId,
          "RAFFLE_ACTIVATED",
        );
      });
    } catch (error) {
      this.translateSingleActiveViolation(error);
    }
  }

  async pause(id: string, adminId: string) {
    return this.dataSource.transaction(async (manager) => {
      const raffle = await this.lockRaffle(manager, id);
      if (raffle.status !== RaffleStatus.ACTIVE)
        throw new DomainError(
          "RAFFLE_PAUSE_NOT_ALLOWED",
          "La rifa no puede pausarse desde su estado actual.",
        );
      return this.applyTransition(
        manager,
        raffle,
        RaffleStatus.PAUSED,
        adminId,
        "RAFFLE_PAUSED",
      );
    });
  }

  async resume(id: string, adminId: string) {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const raffle = await this.lockRaffle(manager, id);
        if (raffle.status !== RaffleStatus.PAUSED)
          throw new DomainError(
            "RAFFLE_RESUME_NOT_ALLOWED",
            "La rifa no puede reanudarse desde su estado actual.",
          );
        return this.applyTransition(
          manager,
          raffle,
          RaffleStatus.ACTIVE,
          adminId,
          "RAFFLE_RESUMED",
        );
      });
    } catch (error) {
      this.translateSingleActiveViolation(error);
    }
  }

  async close(id: string, adminId: string) {
    return this.dataSource.transaction(async (manager) => {
      const raffle = await this.lockRaffle(manager, id);
      if (
        raffle.status !== RaffleStatus.ACTIVE &&
        raffle.status !== RaffleStatus.PAUSED
      )
        throw new DomainError(
          "RAFFLE_CLOSE_NOT_ALLOWED",
          "La rifa no puede cerrarse desde su estado actual.",
        );
      return this.applyTransition(
        manager,
        raffle,
        RaffleStatus.CLOSED,
        adminId,
        "RAFFLE_CLOSED",
      );
    });
  }

  async draw(id: string, winningNumber: number, adminId: string) {
    return this.dataSource.transaction(async (manager) => {
      const raffle = await this.lockRaffle(manager, id);
      if (raffle.status === RaffleStatus.DRAWN)
        throw new DomainError(
          "RAFFLE_ALREADY_DRAWN",
          "La rifa ya fue sorteada.",
        );
      if (raffle.status !== RaffleStatus.CLOSED)
        throw new DomainError(
          "RAFFLE_DRAW_NOT_ALLOWED",
          "La rifa debe estar cerrada antes del sorteo.",
        );

      const reserved = await manager
        .getRepository(RaffleNumber)
        .createQueryBuilder("number")
        .setLock("pessimistic_write")
        .where("number.raffle_id = :id", { id })
        .andWhere("number.status = :status", {
          status: RaffleNumberStatus.RESERVED,
        })
        .orderBy("number.number", "ASC")
        .getMany();
      const nonTerminalOrders = await manager
        .getRepository(RafflePurchase)
        .createQueryBuilder("purchase")
        .innerJoin(Order, "order", "order.id = purchase.order_id")
        .where("purchase.raffle_id = :id", { id })
        .andWhere("order.status IN (:...statuses)", {
          statuses: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_PENDING],
        })
        .getCount();
      if (reserved.length || nonTerminalOrders)
        throw new DomainError(
          "RAFFLE_DRAW_NOT_ALLOWED",
          "La rifa todavía tiene reservas o pagos sin resolver.",
        );

      const winner = await manager
        .getRepository(RaffleNumber)
        .createQueryBuilder("number")
        .setLock("pessimistic_write")
        .where("number.raffle_id = :id", { id })
        .andWhere("number.number = :winningNumber", { winningNumber })
        .getOne();
      if (
        !winner ||
        winner.status !== RaffleNumberStatus.SOLD ||
        !winner.rafflePurchaseId
      )
        throw new DomainError(
          "RAFFLE_WINNING_NUMBER_NOT_ELIGIBLE",
          "El número ganador debe corresponder a una compra pagada.",
        );
      const purchase = await manager.findOneByOrFail(RafflePurchase, {
        id: winner.rafflePurchaseId,
      });
      const order = await manager
        .getRepository(Order)
        .createQueryBuilder("order")
        .setLock("pessimistic_write")
        .where("order.id = :orderId", { orderId: purchase.orderId })
        .getOneOrFail();
      if (order.status !== OrderStatus.PAID)
        throw new DomainError(
          "RAFFLE_WINNING_NUMBER_NOT_ELIGIBLE",
          "El número ganador debe corresponder a una compra pagada.",
        );

      const previousStatus = raffle.status;
      raffle.status = RaffleStatus.DRAWN;
      raffle.winningNumber = winningNumber;
      raffle.drawnAt = new Date();
      raffle.drawnByAdminId = adminId;
      await manager.save(raffle);
      await this.audit(manager, adminId, "RAFFLE_DRAWN", raffle.id, {
        raffleId: raffle.id,
        previousStatus,
        newStatus: raffle.status,
        winningNumber,
      });
      return raffle;
    });
  }

  async numbers(id: string) {
    await this.requireRaffle(id);
    const numbers = await this.dataSource.getRepository(RaffleNumber).find({
      where: { raffleId: id },
      order: { number: "ASC" },
    });
    const purchaseIds = numbers
      .map((number) => number.rafflePurchaseId)
      .filter((value): value is string => value !== null);
    const purchases = purchaseIds.length
      ? await this.dataSource.getRepository(RafflePurchase).findBy({
          id: In(purchaseIds),
        })
      : [];
    const purchaseById = new Map(purchases.map((item) => [item.id, item]));
    const orderIds = purchases.map((item) => item.orderId);
    const orders = orderIds.length
      ? await this.dataSource.getRepository(Order).findBy({ id: In(orderIds) })
      : [];
    const orderById = new Map(orders.map((item) => [item.id, item]));
    const paymentByOrder = await this.latestPaymentByOrder(orderIds);

    return numbers.map((number) => {
      const purchase = number.rafflePurchaseId
        ? purchaseById.get(number.rafflePurchaseId)
        : undefined;
      const order = purchase ? orderById.get(purchase.orderId) : undefined;
      const payment = order ? paymentByOrder.get(order.id) : undefined;
      return {
        number: number.number,
        status: number.status,
        reservedUntil: number.reservedUntil,
        soldAt: number.soldAt,
        rafflePurchaseId: purchase?.id ?? null,
        buyer: purchase
          ? {
              name: purchase.buyerName,
              email: purchase.buyerEmail,
              phone: purchase.buyerPhone,
            }
          : null,
        order: order ? { id: order.id, status: order.status } : null,
        payment: payment ? this.paymentView(payment) : null,
      };
    });
  }

  async purchases(id: string, query: RafflePurchasesListDto) {
    await this.requireRaffle(id);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [purchases, total] = await this.dataSource
      .getRepository(RafflePurchase)
      .findAndCount({
        where: { raffleId: id },
        order: { createdAt: "DESC", id: "ASC" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
    const items = await this.purchaseViews(purchases);
    return { items, page, pageSize, total };
  }

  async purchaseDetail(id: string, purchaseId: string) {
    await this.requireRaffle(id);
    const purchase = await this.dataSource
      .getRepository(RafflePurchase)
      .findOneBy({ id: purchaseId, raffleId: id });
    if (!purchase)
      throw new NotFoundException({
        code: "RAFFLE_PURCHASE_NOT_FOUND",
        message: "La compra de rifa no existe.",
      });
    const [view] = await this.purchaseViews([purchase]);
    const [preference, refunds] = await Promise.all([
      this.dataSource
        .getRepository(PaymentPreference)
        .findOneBy({ orderId: purchase.orderId }),
      this.dataSource.getRepository(RefundOperation).find({
        where: { orderId: purchase.orderId },
        order: { createdAt: "DESC" },
      }),
    ]);
    return {
      ...view,
      preference: preference
        ? {
            id: preference.id,
            providerPreferenceId: preference.providerPreferenceId,
            status: preference.status,
            readyAt: preference.readyAt,
            lastErrorCode: preference.lastErrorCode,
            lastErrorAt: preference.lastErrorAt,
            createdAt: preference.createdAt,
            updatedAt: preference.updatedAt,
          }
        : null,
      refunds: refunds.map((refund) => ({
        id: refund.id,
        status: refund.status,
        amountInCents: refund.amountInCents,
        providerRefundId: refund.providerRefundId,
        completedAt: refund.completedAt,
        createdAt: refund.createdAt,
        updatedAt: refund.updatedAt,
      })),
    };
  }

  private async purchaseViews(purchases: RafflePurchase[]) {
    if (!purchases.length) return [];
    const purchaseIds = purchases.map((item) => item.id);
    const orderIds = purchases.map((item) => item.orderId);
    const [orders, numbers, paymentByOrder] = await Promise.all([
      this.dataSource.getRepository(Order).findBy({ id: In(orderIds) }),
      this.dataSource.getRepository(RaffleNumber).find({
        where: { rafflePurchaseId: In(purchaseIds) },
        order: { number: "ASC" },
      }),
      this.latestPaymentByOrder(orderIds),
    ]);
    const orderById = new Map(orders.map((item) => [item.id, item]));
    const numbersByPurchase = new Map<string, number[]>();
    for (const raffleNumber of numbers) {
      if (!raffleNumber.rafflePurchaseId) continue;
      const existing = numbersByPurchase.get(raffleNumber.rafflePurchaseId);
      if (existing) existing.push(raffleNumber.number);
      else
        numbersByPurchase.set(raffleNumber.rafflePurchaseId, [
          raffleNumber.number,
        ]);
    }
    return purchases.map((purchase) => {
      const order = orderById.get(purchase.orderId)!;
      const payment = paymentByOrder.get(order.id);
      return {
        rafflePurchaseId: purchase.id,
        buyerName: purchase.buyerName,
        buyerEmail: purchase.buyerEmail,
        buyerPhone: purchase.buyerPhone,
        numbers: numbersByPurchase.get(purchase.id) ?? [],
        unitPriceInCents: purchase.unitPriceInCents,
        totalInCents: order.totalInCents,
        status: this.purchaseStatus(order, payment),
        orderId: order.id,
        orderStatus: order.status,
        paymentSource: order.paymentSource,
        manualPaymentMethod: purchase.manualPaymentMethod,
        manualPaymentNote: purchase.manualPaymentNote,
        payment: payment ? this.paymentView(payment) : null,
        createdAt: purchase.createdAt,
        reservationExpiresAt: order.reservationExpiresAt,
        paidAt: order.paidAt,
      };
    });
  }

  private async manualSaleResponseOrConflict(
    order: Order,
    raffleId: string,
    fingerprint: string,
    manager: EntityManager = this.dataSource.manager,
  ) {
    if (
      order.kind !== OrderKind.RAFFLE ||
      order.paymentSource !== OrderPaymentSource.MANUAL ||
      order.requestFingerprint !== fingerprint
    )
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "La clave de idempotencia ya fue usada con otros datos.",
        undefined,
        409,
      );
    const purchase = await manager.findOneBy(RafflePurchase, {
      orderId: order.id,
      raffleId,
    });
    if (!purchase)
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "La clave de idempotencia pertenece a otra operación.",
        undefined,
        409,
      );
    const soldNumbers = await manager.find(RaffleNumber, {
      where: { rafflePurchaseId: purchase.id },
      order: { number: "ASC" },
    });
    return this.manualSaleView(
      order,
      purchase,
      soldNumbers.map((item) => item.number),
    );
  }

  private manualSaleView(
    order: Order,
    purchase: RafflePurchase,
    numbers: number[],
  ) {
    return {
      rafflePurchaseId: purchase.id,
      raffleId: purchase.raffleId,
      orderId: order.id,
      numbers,
      unitPriceInCents: purchase.unitPriceInCents,
      totalInCents: order.totalInCents,
      status: order.status,
      paymentSource: order.paymentSource,
      paymentMethod: purchase.manualPaymentMethod,
      note: purchase.manualPaymentNote,
      paidAt: order.paidAt,
    };
  }

  private async latestPaymentByOrder(orderIds: string[]) {
    const result = new Map<string, Payment>();
    if (!orderIds.length) return result;
    const payments = await this.dataSource.getRepository(Payment).find({
      where: { orderId: In(orderIds) },
      order: { createdAt: "DESC" },
    });
    for (const payment of payments)
      if (!result.has(payment.orderId)) result.set(payment.orderId, payment);
    return result;
  }

  private paymentView(payment: Payment) {
    return {
      id: payment.id,
      providerPaymentId: payment.providerPaymentId,
      providerStatus: payment.providerStatus,
      processingStatus: payment.processingStatus,
      reviewReason: payment.reviewReason,
      transactionAmountInCents: payment.transactionAmountInCents,
      currencyId: payment.currencyId,
      dateCreated: payment.dateCreated,
      dateApproved: payment.dateApproved,
      dateLastUpdated: payment.dateLastUpdated,
    };
  }

  private purchaseStatus(order: Order, payment?: Payment): string {
    if (order.status === OrderStatus.REFUNDED) return "REFUNDED";
    if (payment?.processingStatus === PaymentProcessingStatus.REQUIRES_REVIEW)
      return "REQUIRES_REVIEW";
    if (order.status === OrderStatus.AWAITING_PAYMENT) return "RESERVED";
    if (order.status === OrderStatus.CANCELLED) return "EXPIRED";
    return order.status;
  }

  private async lockRaffle(manager: EntityManager, id: string) {
    const raffle = await manager
      .getRepository(Raffle)
      .createQueryBuilder("raffle")
      .setLock("pessimistic_write")
      .where("raffle.id = :id", { id })
      .getOne();
    if (!raffle)
      throw new NotFoundException({
        code: "RAFFLE_NOT_FOUND",
        message: "La rifa no existe.",
      });
    return raffle;
  }

  private async requireRaffle(id: string) {
    const raffle = await this.dataSource
      .getRepository(Raffle)
      .findOneBy({ id });
    if (!raffle)
      throw new NotFoundException({
        code: "RAFFLE_NOT_FOUND",
        message: "La rifa no existe.",
      });
    return raffle;
  }

  private async applyTransition(
    manager: EntityManager,
    raffle: Raffle,
    status: RaffleStatus,
    adminId: string,
    action:
      | "RAFFLE_ACTIVATED"
      | "RAFFLE_PAUSED"
      | "RAFFLE_RESUMED"
      | "RAFFLE_CLOSED",
  ) {
    const previousStatus = raffle.status;
    raffle.status = status;
    await manager.save(raffle);
    await this.audit(manager, adminId, action, raffle.id, {
      raffleId: raffle.id,
      previousStatus,
      newStatus: raffle.status,
    });
    return raffle;
  }

  private translateSingleActiveViolation(error: unknown): never {
    if (
      error instanceof QueryFailedError &&
      (error as { driverError?: { code?: string; constraint?: string } })
        .driverError?.code === "23505" &&
      (error as { driverError?: { constraint?: string } }).driverError
        ?.constraint === "UQ_raffles_single_active"
    )
      throw new DomainError(
        "RAFFLE_ACTIVE_ALREADY_EXISTS",
        "Ya existe otra rifa activa.",
      );
    throw error;
  }
}
