import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash } from "crypto";
import { DataSource, EntityManager, QueryFailedError } from "typeorm";
import { DomainError } from "../common/domain-error";
import { Order, OrderKind, OrderStatus } from "../orders/entities/order.entity";
import {
  RaffleNumber,
  RaffleNumberStatus,
} from "./entities/raffle-number.entity";
import { RafflePurchase } from "./entities/raffle-purchase.entity";
import { Raffle, RaffleStatus } from "./entities/raffle.entity";
import { raffleReservationConfig } from "./raffle.config";
import { CreateRaffleReservationDto } from "./raffle-reservation.dto";

type Buyer = { name: string; email: string; phone: string };

@Injectable()
export class RaffleReservationsService {
  private readonly logger = new Logger(RaffleReservationsService.name);

  constructor(private readonly dataSource: DataSource) {}

  async reserve(
    raffleId: string,
    dto: CreateRaffleReservationDto,
    idempotencyKey: string,
  ) {
    const key = idempotencyKey?.trim();
    if (!key)
      throw new DomainError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "El header Idempotency-Key es obligatorio.",
        undefined,
        400,
      );
    const numbers = this.normalizeNumbers(dto.numbers);
    const buyer: Buyer = {
      name: dto.buyerName.trim(),
      email: dto.buyerEmail.trim().toLowerCase(),
      phone: dto.buyerPhone.trim(),
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ raffleId, numbers, buyer }))
      .digest("hex");

    this.trace("raffle_reservation_started", {
      raffleId,
      numbers,
      numberCount: numbers.length,
    });

    const existing = await this.dataSource.getRepository(Order).findOneBy({
      idempotencyKey: key,
    });
    if (existing) return this.responseOrConflict(existing, fingerprint);

    try {
      return await this.dataSource.transaction((manager) =>
        this.reserveInTransaction(
          manager,
          raffleId,
          numbers,
          buyer,
          key,
          fingerprint,
        ),
      );
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as { code?: string }).code === "23505"
      ) {
        const concurrent = await this.dataSource
          .getRepository(Order)
          .findOneBy({ idempotencyKey: key });
        if (concurrent) return this.responseOrConflict(concurrent, fingerprint);
      }
      throw error;
    }
  }

  private async reserveInTransaction(
    manager: EntityManager,
    raffleId: string,
    numbers: number[],
    buyer: Buyer,
    idempotencyKey: string,
    fingerprint: string,
  ) {
    await manager.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`raffle:${raffleId}:${buyer.email}`],
    );

    const existing = await manager.findOneBy(Order, { idempotencyKey });
    if (existing)
      return this.responseOrConflict(existing, fingerprint, manager);

    const raffle = await manager
      .getRepository(Raffle)
      .createQueryBuilder("raffle")
      .setLock("pessimistic_write")
      .where("raffle.id = :raffleId", { raffleId })
      .getOne();
    if (!raffle)
      throw new NotFoundException({
        code: "RAFFLE_NOT_FOUND",
        message: "La rifa no existe.",
      });
    if (raffle.status !== RaffleStatus.ACTIVE)
      throw new DomainError(
        "RAFFLE_NOT_ACTIVE",
        "La rifa no está disponible para nuevas reservas.",
      );

    const config = raffleReservationConfig();
    const now = new Date();
    const activeReservations = await manager
      .getRepository(RafflePurchase)
      .createQueryBuilder("purchase")
      .innerJoin(Order, "order", "order.id = purchase.order_id")
      .where("purchase.raffle_id = :raffleId", { raffleId })
      .andWhere("purchase.buyer_email = :email", { email: buyer.email })
      .andWhere("order.kind = :kind", { kind: OrderKind.RAFFLE })
      .andWhere("order.status IN (:...statuses)", {
        statuses: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_PENDING],
      })
      .andWhere("order.reservation_expires_at > :now", { now })
      .getCount();
    if (activeReservations >= config.maxActiveReservationsPerEmail) {
      this.trace("raffle_reservation_limit_reached", {
        raffleId,
        numberCount: numbers.length,
        processingResult: "ACTIVE_RESERVATION_LIMIT",
      });
      throw new DomainError(
        "ACTIVE_RESERVATION_LIMIT",
        "Alcanzaste el límite de reservas activas para esta rifa.",
      );
    }

    const lockedNumbers = await manager
      .getRepository(RaffleNumber)
      .createQueryBuilder("raffleNumber")
      .setLock("pessimistic_write")
      .where("raffleNumber.raffle_id = :raffleId", { raffleId })
      .andWhere("raffleNumber.number IN (:...numbers)", { numbers })
      .orderBy("raffleNumber.number", "ASC")
      .getMany();
    const byNumber = new Map(
      lockedNumbers.map((raffleNumber) => [raffleNumber.number, raffleNumber]),
    );
    const unavailable = numbers.filter(
      (number) => byNumber.get(number)?.status !== RaffleNumberStatus.AVAILABLE,
    );
    if (unavailable.length) {
      this.trace("raffle_reservation_conflict", {
        raffleId,
        numbers: unavailable,
        numberCount: unavailable.length,
        processingResult: "RAFFLE_NUMBER_UNAVAILABLE",
      });
      throw new DomainError(
        "RAFFLE_NUMBER_UNAVAILABLE",
        "Uno o más números ya no están disponibles.",
        { numbers: unavailable },
      );
    }

    const reservationExpiresAt = new Date(
      now.getTime() + config.reservationMinutes * 60_000,
    );
    const totalInCents = raffle.priceInCents * numbers.length;
    const order = await manager.save(Order, {
      kind: OrderKind.RAFFLE,
      status: OrderStatus.AWAITING_PAYMENT,
      idempotencyKey,
      requestFingerprint: fingerprint,
      subtotalInCents: totalInCents,
      totalInCents,
      reservationExpiresAt,
      paidAt: null,
    });
    const purchase = await manager.save(RafflePurchase, {
      raffleId,
      orderId: order.id,
      buyerName: buyer.name,
      buyerEmail: buyer.email,
      buyerPhone: buyer.phone,
      unitPriceInCents: raffle.priceInCents,
    });
    for (const raffleNumber of lockedNumbers) {
      raffleNumber.status = RaffleNumberStatus.RESERVED;
      raffleNumber.rafflePurchaseId = purchase.id;
      raffleNumber.reservedAt = now;
      raffleNumber.reservedUntil = reservationExpiresAt;
      raffleNumber.soldAt = null;
    }
    await manager.save(lockedNumbers);

    this.trace("raffle_reservation_created", {
      raffleId,
      rafflePurchaseId: purchase.id,
      orderId: order.id,
      numbers,
      numberCount: numbers.length,
      processingResult: "RESERVED",
    });
    return this.response(order, purchase, lockedNumbers);
  }

  private normalizeNumbers(value: unknown): number[] {
    if (!Array.isArray(value) || value.length === 0)
      throw new DomainError(
        "RAFFLE_NUMBER_INVALID",
        "Debés seleccionar al menos un número entero entre 0 y 99.",
        undefined,
        400,
      );
    if (
      value.some(
        (number) =>
          typeof number !== "number" ||
          !Number.isInteger(number) ||
          number < 0 ||
          number > 99,
      ) ||
      new Set(value).size !== value.length
    )
      throw new DomainError(
        "RAFFLE_NUMBER_INVALID",
        "Los números deben ser enteros únicos entre 0 y 99.",
        undefined,
        400,
      );
    return [...value].sort((left, right) => left - right) as number[];
  }

  private async responseOrConflict(
    order: Order,
    fingerprint: string,
    manager: EntityManager = this.dataSource.manager,
  ) {
    if (
      order.kind !== OrderKind.RAFFLE ||
      order.requestFingerprint !== fingerprint
    )
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "La clave de idempotencia fue utilizada con otros datos.",
      );
    if (
      order.status === OrderStatus.EXPIRED ||
      order.reservationExpiresAt <= new Date()
    )
      throw new DomainError(
        "RAFFLE_RESERVATION_EXPIRED",
        "La reserva asociada a esta clave ya venció.",
      );
    const purchase = await manager.findOneBy(RafflePurchase, {
      orderId: order.id,
    });
    if (!purchase)
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "La clave de idempotencia no pertenece a una reserva de rifa.",
      );
    const numbers = await manager.find(RaffleNumber, {
      where: { rafflePurchaseId: purchase.id },
      order: { number: "ASC" },
    });
    return this.response(order, purchase, numbers);
  }

  private response(
    order: Order,
    purchase: RafflePurchase,
    numbers: RaffleNumber[],
  ) {
    return {
      rafflePurchaseId: purchase.id,
      orderId: order.id,
      raffleId: purchase.raffleId,
      numbers: numbers.map((number) => number.number),
      unitPriceInCents: purchase.unitPriceInCents,
      totalInCents: order.totalInCents,
      reservationExpiresAt: order.reservationExpiresAt,
    };
  }

  private trace(step: string, fields: Record<string, unknown>) {
    this.logger.log({ step, ...fields });
  }
}
