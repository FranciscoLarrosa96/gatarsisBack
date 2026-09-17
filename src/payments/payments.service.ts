import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource, In, LessThanOrEqual } from "typeorm";
import { DomainError } from "../common/domain-error";
import { mercadoPagoConfig } from "../config/database.config";
import { InventoryService } from "../inventory/inventory.service";
import { Order, OrderKind, OrderStatus } from "../orders/entities/order.entity";
import { OrderItem } from "../orders/entities/order-item.entity";
import { RaffleNumber } from "../raffles/entities/raffle-number.entity";
import { RafflePurchase } from "../raffles/entities/raffle-purchase.entity";
import {
  RaffleLifecycleService,
  RafflePreferenceContext,
} from "../raffles/raffle-lifecycle.service";
import { centsToMercadoPagoAmount, mercadoPagoAmountToCents } from "./money";
import {
  MERCADO_PAGO_GATEWAY,
  MercadoPagoGatewayContract,
  MercadoPagoPayment,
} from "./mercado-pago.gateway";
import { Payment, PaymentProcessingStatus } from "./entities/payment.entity";
import {
  PaymentPreference,
  PaymentPreferenceStatus,
} from "./entities/payment-preference.entity";
import {
  WebhookEvent,
  WebhookEventStatus,
} from "./entities/webhook-event.entity";

type PreferenceAction = "READY" | "CREATE" | "RECOVER";
const PROVIDER_PENDING_STATUSES = [
  "pending",
  "in_process",
  "in_mediation",
  "authorized",
] as const;
const isProviderPending = (status: string) =>
  PROVIDER_PENDING_STATUSES.includes(
    status as (typeof PROVIDER_PENDING_STATUSES)[number],
  );

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly config = mercadoPagoConfig();
  constructor(
    private readonly dataSource: DataSource,
    private readonly inventory: InventoryService,
    private readonly raffleLifecycle: RaffleLifecycleService,
    @Inject(MERCADO_PAGO_GATEWAY)
    private readonly gateway: MercadoPagoGatewayContract,
  ) {}

  private trace(step: string, context: Record<string, unknown>) {
    this.logger.log({ step, ...context });
  }

  private errorCode(error: unknown): string {
    if (error instanceof DomainError) return error.code;
    if (typeof error === "object" && error && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    return error instanceof Error ? error.name : "UNKNOWN_ERROR";
  }

  async createPreference(orderId: string) {
    if (!this.config.enabled)
      throw new DomainError(
        "PAYMENT_PROVIDER_UNAVAILABLE",
        "Mercado Pago no está habilitado.",
        undefined,
        503,
      );
    let raffleContext: RafflePreferenceContext | undefined;
    const prepared = await this.dataSource.transaction(async (manager) => {
      const order = await manager
        .createQueryBuilder(Order, "order")
        .setLock("pessimistic_write")
        .where("order.id = :orderId", { orderId })
        .getOne();
      if (!order)
        throw new DomainError(
          "ORDER_EXPIRED",
          "La orden no está disponible para pago.",
        );
      if (order.kind === OrderKind.RAFFLE)
        this.trace("raffle_preference_started", { orderId: order.id });
      if (order.status === OrderStatus.EXPIRED)
        throw this.unavailableOrderForPreference(order);
      if (order.status === OrderStatus.PAID)
        throw new DomainError("ORDER_ALREADY_PAID", "La orden ya fue pagada.");
      if (
        order.kind === OrderKind.RAFFLE &&
        order.status !== OrderStatus.AWAITING_PAYMENT
      )
        throw new DomainError(
          "PAYMENT_PREFERENCE_NOT_READY",
          "La reserva de rifa no admite una preference.",
        );
      if (
        order.kind === OrderKind.MERCH &&
        order.status !== OrderStatus.AWAITING_PAYMENT &&
        order.status !== OrderStatus.PAYMENT_PENDING
      )
        throw new DomainError(
          "PAYMENT_PREFERENCE_NOT_READY",
          "La orden no admite una preference.",
        );
      if (order.reservationExpiresAt <= new Date())
        throw this.unavailableOrderForPreference(order);
      raffleContext =
        order.kind === OrderKind.RAFFLE
          ? await this.raffleLifecycle.preferenceContext(manager, order)
          : undefined;
      let preference = await manager
        .createQueryBuilder(PaymentPreference, "preference")
        .setLock("pessimistic_write")
        .where("preference.order_id = :orderId", { orderId })
        .getOne();
      if (preference?.status === PaymentPreferenceStatus.READY)
        return { order, preference, action: "READY" as PreferenceAction };

      const now = new Date();
      if (preference?.status === PaymentPreferenceStatus.CREATING) {
        const staleAt = new Date(
          now.getTime() - this.config.preferenceCreatingStaleSeconds * 1000,
        );
        if (preference.updatedAt > staleAt)
          throw new DomainError(
            "PAYMENT_PREFERENCE_NOT_READY",
            "La preference se está creando; reintentá en instantes.",
            undefined,
            409,
          );
        this.logger.warn({
          step: "payment_preference_stale_creating",
          orderId,
          ageSeconds: Math.floor(
            (now.getTime() - preference.updatedAt.getTime()) / 1000,
          ),
          processingResult: "RECOVERY_REQUIRED",
        });
        preference.status = PaymentPreferenceStatus.REQUIRES_REVIEW;
        preference.lastErrorCode = "CREATING_STALE";
        preference.lastErrorAt = now;
        preference = await manager.save(preference);
        return { order, preference, action: "RECOVER" as PreferenceAction };
      }

      if (
        preference?.status === PaymentPreferenceStatus.FAILED &&
        preference.lastErrorCode === "RECOVERY_CONFIRMED_NOT_FOUND"
      ) {
        preference.status = PaymentPreferenceStatus.CREATING;
        preference.providerPreferenceId = null;
        preference.initPoint = null;
        preference.lastErrorCode = null;
        preference.lastErrorAt = null;
        preference = await manager.save(preference);
        return { order, preference, action: "CREATE" as PreferenceAction };
      }

      if (preference) {
        if (preference.status !== PaymentPreferenceStatus.REQUIRES_REVIEW) {
          preference.status = PaymentPreferenceStatus.REQUIRES_REVIEW;
          preference.lastErrorCode = "LEGACY_CREATION_STATE_REQUIRES_RECOVERY";
          preference.lastErrorAt = now;
          preference = await manager.save(preference);
        }
        return { order, preference, action: "RECOVER" as PreferenceAction };
      }

      preference = await manager.save(PaymentPreference, {
        orderId,
        provider: "mercado_pago",
        status: PaymentPreferenceStatus.CREATING,
        providerPreferenceId: null,
        initPoint: null,
        lastErrorCode: null,
        lastErrorAt: null,
        readyAt: null,
        lastReconciliationAt: null,
      });
      return { order, preference, action: "CREATE" as PreferenceAction };
    });

    if (prepared.action === "READY") {
      this.traceRafflePreferenceReady(prepared.order, raffleContext);
      return this.preferenceResponse(prepared.order, prepared.preference);
    }

    if (prepared.action === "RECOVER") {
      const recovered = await this.recoverPreference(orderId);
      if (recovered) {
        this.traceRafflePreferenceReady(prepared.order, raffleContext);
        return this.preferenceResponse(prepared.order, recovered);
      }
      throw this.preferenceCreationPending();
    }

    return this.createRemotePreference(prepared.order, raffleContext);
  }

  async createRafflePreference(rafflePurchaseId: string) {
    const purchase = await this.dataSource
      .getRepository(RafflePurchase)
      .findOneBy({ id: rafflePurchaseId });
    if (!purchase)
      throw new DomainError(
        "RAFFLE_PURCHASE_NOT_FOUND",
        "La compra de rifa no existe.",
        undefined,
        404,
      );
    return this.createPreference(purchase.orderId);
  }

  private async createRemotePreference(
    order: Order,
    raffleContext?: RafflePreferenceContext,
  ) {
    const items = raffleContext
      ? [
          {
            id: raffleContext.item.id,
            title: raffleContext.item.title,
            description: raffleContext.item.description,
            quantity: raffleContext.item.quantity,
            unit_price: centsToMercadoPagoAmount(
              raffleContext.item.unitPriceInCents,
            ),
            currency_id: "ARS",
          },
        ]
      : (
          await this.dataSource
            .getRepository(OrderItem)
            .findBy({ orderId: order.id })
        ).map((item) => ({
          id: item.skuSnapshot,
          title: item.productNameSnapshot,
          quantity: item.quantity,
          unit_price: centsToMercadoPagoAmount(item.unitPriceInCents),
        }));
    try {
      const created = await this.gateway.createPreference(
        this.preferencePayload(order, items),
      );
      const preference = await this.readyPreference(order.id, created);
      this.traceRafflePreferenceReady(order, raffleContext);
      return this.preferenceResponse(order, preference);
    } catch (error) {
      await this.markPreferenceAmbiguous(order.id, "CREATE_AMBIGUOUS");
      const recovered = await this.recoverPreference(order.id);
      if (recovered) {
        this.traceRafflePreferenceReady(order, raffleContext);
        return this.preferenceResponse(order, recovered);
      }
      this.logger.warn({
        step: "payment_preference_creation_ambiguous",
        orderId: order.id,
        errorCode: this.errorCode(error),
        processingResult: "REQUIRES_REVIEW",
      });
      throw this.preferenceCreationPending();
    }
  }

  private preferencePayload(
    order: Order,
    items: Array<{
      id: string;
      title: string;
      description?: string;
      quantity: number;
      unit_price: number;
      currency_id?: string;
    }>,
  ) {
    const frontendUrl = this.config.frontendUrl;
    return {
      items,
      external_reference: order.id,
      back_urls: {
        success: `${frontendUrl}/checkout/success`,
        pending: `${frontendUrl}/checkout/pending`,
        failure: `${frontendUrl}/checkout/failure`,
      },
      auto_return: "approved",
      expires: true,
      expiration_date_from: new Date().toISOString(),
      expiration_date_to: order.reservationExpiresAt.toISOString(),
      binary_mode: this.config.binaryMode,
      ...(this.config.excludeTicket
        ? { payment_methods: { excluded_payment_types: [{ id: "ticket" }] } }
        : {}),
    };
  }

  private unavailableOrderForPreference(order: Order): DomainError {
    return order.kind === OrderKind.RAFFLE
      ? new DomainError(
          "RAFFLE_RESERVATION_EXPIRED",
          "La reserva de la rifa ya venció.",
        )
      : new DomainError("ORDER_EXPIRED", "La reserva ya venció.");
  }

  private traceRafflePreferenceReady(
    order: Order,
    context?: RafflePreferenceContext,
  ): void {
    if (order.kind !== OrderKind.RAFFLE || !context) return;
    this.trace("raffle_preference_ready", {
      orderId: order.id,
      raffleId: context.raffleId,
      rafflePurchaseId: context.rafflePurchaseId,
      numberCount: context.item.quantity,
      processingResult: "READY",
    });
  }
  private async readyPreference(
    orderId: string,
    remote: { id: string; init_point: string },
  ) {
    return this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder(Order, "order")
        .setLock("pessimistic_write")
        .where("order.id = :orderId", { orderId })
        .getOneOrFail();
      const preference = await manager
        .createQueryBuilder(PaymentPreference, "preference")
        .setLock("pessimistic_write")
        .where("preference.order_id = :orderId", { orderId })
        .getOneOrFail();
      if (preference.status === PaymentPreferenceStatus.READY)
        return preference;
      preference.providerPreferenceId = remote.id;
      preference.initPoint = remote.init_point;
      preference.status = PaymentPreferenceStatus.READY;
      preference.readyAt = new Date();
      preference.lastErrorCode = null;
      preference.lastErrorAt = null;
      preference.lastReconciliationAt = new Date();
      return manager.save(preference);
    });
  }

  private async recoverPreference(orderId: string) {
    this.trace("payment_preference_recovery_started", {
      orderId,
      processingResult: "SEARCHING_BY_EXTERNAL_REFERENCE",
    });
    let matches: Awaited<
      ReturnType<
        MercadoPagoGatewayContract["searchPreferencesByExternalReference"]
      >
    >;
    try {
      matches =
        await this.gateway.searchPreferencesByExternalReference(orderId);
    } catch (error) {
      await this.markPreferenceAmbiguous(orderId, "RECOVERY_UNAVAILABLE");
      this.logger.warn({
        step: "payment_preference_recovery_failed",
        orderId,
        errorCode: this.errorCode(error),
        processingResult: "REQUIRES_REVIEW",
      });
      return null;
    }

    if (matches.length === 1) {
      const preference = await this.readyPreference(orderId, matches[0]);
      this.trace("payment_preference_recovery_succeeded", {
        orderId,
        providerPreferenceId: preference.providerPreferenceId,
        processingResult: "READY",
      });
      return preference;
    }
    if (matches.length > 1) {
      await this.markPreferenceAmbiguous(orderId, "RECOVERY_MULTIPLE_MATCHES");
      this.logger.warn({
        step: "payment_preference_recovery_ambiguous",
        orderId,
        matchCount: matches.length,
        processingResult: "REQUIRES_REVIEW",
      });
      return null;
    }

    await this.recordPreferenceNotFound(orderId);
    return null;
  }

  private async markPreferenceAmbiguous(orderId: string, code: string) {
    await this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder(Order, "order")
        .setLock("pessimistic_write")
        .where("order.id = :orderId", { orderId })
        .getOne();
      const preference = await manager
        .createQueryBuilder(PaymentPreference, "preference")
        .setLock("pessimistic_write")
        .where("preference.order_id = :orderId", { orderId })
        .getOne();
      if (!preference || preference.status === PaymentPreferenceStatus.READY)
        return;
      preference.status = PaymentPreferenceStatus.REQUIRES_REVIEW;
      preference.lastErrorCode = code;
      preference.lastErrorAt = new Date();
      await manager.save(preference);
    });
  }

  private async recordPreferenceNotFound(orderId: string) {
    await this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder(Order, "order")
        .setLock("pessimistic_write")
        .where("order.id = :orderId", { orderId })
        .getOne();
      const preference = await manager
        .createQueryBuilder(PaymentPreference, "preference")
        .setLock("pessimistic_write")
        .where("preference.order_id = :orderId", { orderId })
        .getOne();
      if (
        !preference ||
        preference.status === PaymentPreferenceStatus.READY ||
        (preference.status === PaymentPreferenceStatus.CREATING &&
          Date.now() - preference.updatedAt.getTime() <
            this.config.preferenceCreatingStaleSeconds * 1000)
      )
        return;

      const now = new Date();
      const alreadyNotFound =
        preference.status === PaymentPreferenceStatus.REQUIRES_REVIEW &&
        preference.lastErrorCode === "RECOVERY_NOT_FOUND";
      const absenceConfirmed =
        alreadyNotFound &&
        preference.lastErrorAt !== null &&
        now.getTime() - preference.lastErrorAt.getTime() >=
          this.config.preferenceRecoveryConfirmSeconds * 1000;
      preference.lastReconciliationAt = now;
      if (absenceConfirmed) {
        preference.status = PaymentPreferenceStatus.FAILED;
        preference.lastErrorCode = "RECOVERY_CONFIRMED_NOT_FOUND";
        preference.lastErrorAt = now;
        await manager.save(preference);
        this.trace("payment_preference_absence_confirmed", {
          orderId,
          processingResult: "FAILED_RETRYABLE",
        });
        return;
      }

      preference.status = PaymentPreferenceStatus.REQUIRES_REVIEW;
      preference.lastErrorCode = "RECOVERY_NOT_FOUND";
      if (!alreadyNotFound || !preference.lastErrorAt)
        preference.lastErrorAt = now;
      await manager.save(preference);
      this.trace("payment_preference_recovery_not_found", {
        orderId,
        processingResult: "REQUIRES_REVIEW",
      });
    });
  }

  private preferenceCreationPending() {
    return new DomainError(
      "PAYMENT_PREFERENCE_CREATION_FAILED",
      "No se pudo confirmar la creación de la preference de pago. Reintentá en instantes.",
      undefined,
      503,
    );
  }
  private preferenceResponse(order: Order, preference: PaymentPreference) {
    return {
      orderId: order.id,
      preferenceId: preference.providerPreferenceId,
      initPoint: preference.initPoint,
      reservationExpiresAt: order.reservationExpiresAt,
    };
  }
  async status(orderId: string) {
    const order = await this.dataSource
      .getRepository(Order)
      .findOneBy({ id: orderId });
    if (!order)
      throw new DomainError(
        "ORDER_NOT_FOUND",
        "La orden no existe.",
        undefined,
        404,
      );
    return {
      orderId: order.id,
      status: order.status.toLowerCase(),
      reservationExpiresAt: order.reservationExpiresAt,
      paidAt: order.paidAt,
    };
  }

  async rafflePurchaseStatus(rafflePurchaseId: string) {
    const purchase = await this.dataSource
      .getRepository(RafflePurchase)
      .findOneBy({ id: rafflePurchaseId });
    if (!purchase)
      throw new DomainError(
        "RAFFLE_PURCHASE_NOT_FOUND",
        "La compra de rifa no existe.",
        undefined,
        404,
      );
    const [order, payment, numbers] = await Promise.all([
      this.dataSource.getRepository(Order).findOneByOrFail({
        id: purchase.orderId,
      }),
      this.dataSource.getRepository(Payment).findOne({
        where: { orderId: purchase.orderId },
        order: { createdAt: "DESC" },
      }),
      this.dataSource.getRepository(RaffleNumber).find({
        where: { rafflePurchaseId: purchase.id },
        order: { number: "ASC" },
      }),
    ]);
    const status =
      order.status === OrderStatus.REFUNDED
        ? "REFUNDED"
        : payment?.processingStatus === PaymentProcessingStatus.REQUIRES_REVIEW
          ? "REQUIRES_REVIEW"
          : order.status === OrderStatus.AWAITING_PAYMENT
            ? "RESERVED"
            : order.status === OrderStatus.CANCELLED
              ? "EXPIRED"
              : order.status;
    return {
      rafflePurchaseId: purchase.id,
      orderId: order.id,
      status,
      numbers: numbers.map((item) => item.number),
      reservationExpiresAt: order.reservationExpiresAt,
      paidAt: order.paidAt,
    };
  }

  async receiveWebhook(input: {
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
  }) {
    const dataId = input.query["data.id"];
    const bodyDataId =
      typeof input.body.data === "object" &&
      input.body.data &&
      "id" in input.body.data
        ? String((input.body.data as { id?: unknown }).id ?? "") || null
        : null;
    const queryDataId = Array.isArray(dataId) ? dataId[0] : (dataId ?? null);
    this.logger.log({
      hasXSignature: Boolean(input.headers["x-signature"]),
      hasXRequestId: Boolean(input.headers["x-request-id"]),
      dataId: queryDataId,
      bodyDataId,
      dataIdSource: "query.data.id",
      queryAndBodyDataIdMatch:
        bodyDataId === null ? null : bodyDataId === queryDataId,
      webhookSecretConfigured: Boolean(this.config.webhookSecret),
    });
    try {
      this.gateway.validateWebhookSignature({
        xSignature: input.headers["x-signature"],
        xRequestId: input.headers["x-request-id"],
        dataId,
      });
      this.trace("webhook_signature_valid", {
        providerPaymentId: Array.isArray(dataId) ? dataId[0] : (dataId ?? null),
        processingResult: "SIGNATURE_VALID",
      });
    } catch {
      this.trace("webhook_immediate_processing_skipped", {
        providerPaymentId: Array.isArray(dataId) ? dataId[0] : (dataId ?? null),
        processingResult: "INVALID_SIGNATURE",
      });
      throw new DomainError(
        "INVALID_WEBHOOK_SIGNATURE",
        "La firma del webhook es inválida.",
        undefined,
        401,
      );
    }
    const queryType = input.query.type;
    const type = String(
      input.body.type ??
        input.body.topic ??
        (Array.isArray(queryType) ? queryType[0] : queryType) ??
        "",
    );
    const providerPaymentId = Array.isArray(dataId) ? dataId[0] : dataId;
    if (type !== "payment" || !providerPaymentId) {
      this.trace("webhook_immediate_processing_skipped", {
        providerPaymentId: providerPaymentId ?? null,
        processingResult: "IGNORED_NON_PAYMENT_OR_MISSING_ID",
      });
      return { received: true };
    }
    if (bodyDataId !== null && bodyDataId !== providerPaymentId) {
      this.trace("webhook_immediate_processing_skipped", {
        providerPaymentId,
        processingResult: "QUERY_BODY_RESOURCE_ID_MISMATCH",
      });
      throw new DomainError(
        "WEBHOOK_RESOURCE_ID_MISMATCH",
        "El recurso del webhook no coincide entre query y payload.",
        undefined,
        400,
      );
    }
    const eventId = input.body.id ? String(input.body.id) : null;
    let webhookEventId: string | null = null;
    const events = this.dataSource.getRepository(WebhookEvent);
    try {
      const created = await events.save(
        events.create({
          provider: "mercado_pago",
          providerEventId: eventId,
          providerResourceId: providerPaymentId,
          type,
          action: input.body.action ? String(input.body.action) : null,
          requestId: Array.isArray(input.headers["x-request-id"])
            ? input.headers["x-request-id"][0]
            : (input.headers["x-request-id"] ?? null),
          status: WebhookEventStatus.PENDING,
          attempts: 0,
          nextAttemptAt: null,
          lastError: null,
          payload: input.body as any,
          receivedAt: new Date(),
          processedAt: null,
        }),
      );
      webhookEventId = created.id;
      this.trace("webhook_inbox_created", {
        providerPaymentId,
        webhookEventId,
        processingResult: "PENDING",
      });
    } catch (error: unknown) {
      if (!String((error as { code?: string }).code).includes("23505")) {
        this.trace("webhook_immediate_processing_failed", {
          providerPaymentId,
          processingResult: `INBOX_PERSIST_${this.errorCode(error)}`,
        });
        throw error;
      }
      const existing = eventId
        ? await events.findOneBy({
            provider: "mercado_pago",
            providerEventId: eventId,
          })
        : null;
      this.trace("webhook_inbox_existing", {
        providerPaymentId,
        webhookEventId: existing?.id ?? null,
        processingResult: existing?.status ?? "DUPLICATE_NOT_FOUND",
      });
      if (existing && existing.status !== WebhookEventStatus.PROCESSED) {
        await events.update(existing.id, {
          providerResourceId: providerPaymentId,
          status: WebhookEventStatus.PENDING,
          attempts: 0,
          nextAttemptAt: null,
          lastError: null,
        });
        webhookEventId = existing.id;
        this.trace("webhook_requeued", {
          providerPaymentId,
          webhookEventId,
          processingResult: "PENDING_RESOURCE_ID_REFRESHED",
        });
      } else {
        this.trace("webhook_immediate_processing_skipped", {
          providerPaymentId,
          webhookEventId: existing?.id ?? null,
          processingResult: existing
            ? "ALREADY_PROCESSED"
            : "DUPLICATE_EVENT_NOT_FOUND",
        });
      }
    }
    if (!webhookEventId) {
      this.trace("webhook_immediate_processing_skipped", {
        providerPaymentId,
        processingResult: "NO_INBOX_EVENT_ID",
      });
      return { received: true };
    }
    // Confirm receipt as soon as the signed notification is safely stored.
    // Mercado Pago expects a 200/201 within 22 seconds; the inbox worker below
    // performs the provider lookup and settlement asynchronously.
    this.trace("webhook_processing_queued", {
      providerPaymentId,
      webhookEventId,
      processingResult: "PENDING",
    });
    return { received: true };
  }

  @Cron("15 * * * * *") async processWebhookInbox() {
    const now = new Date();
    const events = await this.dataSource.getRepository(WebhookEvent).find({
      where: [
        { status: WebhookEventStatus.PENDING },
        {
          status: WebhookEventStatus.RETRY,
          nextAttemptAt: LessThanOrEqual(now),
        },
      ],
      take: 25,
      order: { receivedAt: "ASC" },
    });
    for (const event of events) await this.processWebhookEvent(event.id);
  }
  async processWebhookEvent(id: string) {
    const event = await this.dataSource
      .getRepository(WebhookEvent)
      .findOneBy({ id });
    if (!event || event.status === WebhookEventStatus.PROCESSED) {
      this.trace("webhook_event_skipped", {
        webhookEventId: id,
        providerPaymentId: event?.providerResourceId ?? null,
        processingResult: event ? "ALREADY_PROCESSED" : "NOT_FOUND",
      });
      return "SKIPPED";
    }
    try {
      this.trace("webhook_gateway_get_payment_started", {
        webhookEventId: id,
        providerPaymentId: event.providerResourceId,
      });
      const remote = await this.gateway.getPayment(event.providerResourceId);
      this.trace("webhook_gateway_get_payment_succeeded", {
        webhookEventId: id,
        providerPaymentId: remote.id,
        orderId: remote.external_reference ?? null,
        processingResult: remote.status,
      });
      await this.recordAndApply(remote);
      await this.dataSource.getRepository(WebhookEvent).update(id, {
        status: WebhookEventStatus.PROCESSED,
        processedAt: new Date(),
        lastError: null,
      });
      this.trace("webhook_event_processed", {
        webhookEventId: id,
        providerPaymentId: remote.id,
        orderId: remote.external_reference ?? null,
        processingResult: "PROCESSED",
      });
      return "PROCESSED";
    } catch (error) {
      const attempts = event.attempts + 1;
      await this.dataSource.getRepository(WebhookEvent).update(id, {
        status:
          attempts >= 4
            ? WebhookEventStatus.DEAD_LETTER
            : WebhookEventStatus.RETRY,
        attempts,
        nextAttemptAt: new Date(
          Date.now() + [5000, 30000, 120000, 600000][Math.min(attempts - 1, 3)],
        ),
        lastError:
          error instanceof Error
            ? error.message.slice(0, 250)
            : "Unknown error",
      });
      this.logger.warn({
        step: "webhook_event_failed",
        webhookEventId: id,
        providerPaymentId: event.providerResourceId,
        processingResult:
          attempts >= 4
            ? WebhookEventStatus.DEAD_LETTER
            : WebhookEventStatus.RETRY,
        errorCode: this.errorCode(error),
      });
      return "FAILED";
    }
  }

  async recordAndApply(remote: MercadoPagoPayment) {
    const orderId = remote.external_reference;
    if (!orderId) {
      this.trace("payment_ignored_missing_order_reference", {
        providerPaymentId: remote.id,
        processingResult: "MISSING_EXTERNAL_REFERENCE",
      });
      return;
    }
    this.trace("payment_record_started", {
      providerPaymentId: remote.id,
      orderId,
    });
    await this.dataSource.transaction(async (manager) => {
      const order = await manager
        .createQueryBuilder(Order, "order")
        .setLock("pessimistic_write")
        .where("order.id = :orderId", { orderId })
        .getOne();
      if (!order) {
        this.trace("payment_ignored_order_not_found", {
          providerPaymentId: remote.id,
          orderId,
          processingResult: "ORDER_NOT_FOUND",
        });
        return;
      }
      let payment = await manager.findOne(Payment, {
        where: { provider: "mercado_pago", providerPaymentId: remote.id },
      });
      if (payment && payment.orderId !== order.id) {
        this.logger.warn({
          step: "payment_provider_order_conflict",
          providerPaymentId: remote.id,
          orderId,
          originalOrderId: payment.orderId,
          processingResult: "REQUIRES_REVIEW",
        });
        payment.reviewReason = "PROVIDER_PAYMENT_ORDER_CONFLICT";
        if (payment.processingStatus !== PaymentProcessingStatus.APPLIED) {
          payment.processingStatus = PaymentProcessingStatus.REQUIRES_REVIEW;
        }
        await manager.save(payment);
        return;
      }
      const wasApplied =
        payment?.processingStatus === PaymentProcessingStatus.APPLIED;
      const fields = {
        orderId,
        provider: "mercado_pago",
        providerPaymentId: remote.id,
        providerStatus: remote.status,
        providerStatusDetail: remote.status_detail ?? null,
        transactionAmountInCents: mercadoPagoAmountToCents(
          remote.transaction_amount,
        ),
        currencyId: remote.currency_id,
        externalReference: remote.external_reference ?? null,
        paymentMethodId: remote.payment_method_id ?? null,
        paymentTypeId: remote.payment_type_id ?? null,
        dateCreated: this.date(remote.date_created),
        dateApproved: this.date(remote.date_approved),
        dateLastUpdated: this.date(remote.date_last_updated),
      };
      if (!payment)
        payment = manager.create(Payment, {
          ...fields,
          processingStatus: PaymentProcessingStatus.RECEIVED,
        });
      else Object.assign(payment, fields);
      await manager.save(payment);
      if (wasApplied) {
        if (remote.status !== "approved" || order.status !== OrderStatus.PAID)
          this.logger.warn({
            step: "payment_terminal_state_preserved",
            providerPaymentId: remote.id,
            orderId: order.id,
            status: remote.status,
            processingResult: "APPLIED_PAID_NOT_DEGRADED",
          });
        return;
      }
      if (
        order.status === OrderStatus.PAID ||
        order.status === OrderStatus.REFUNDED ||
        order.status === OrderStatus.CANCELLED
      ) {
        payment.processingStatus = PaymentProcessingStatus.REQUIRES_REVIEW;
        payment.reviewReason = "ORDER_TERMINAL_STATE_CONFLICT";
        await manager.save(payment);
        this.logger.warn({
          step: "payment_terminal_order_preserved",
          providerPaymentId: remote.id,
          orderId: order.id,
          status: remote.status,
          processingResult: "REQUIRES_REVIEW",
        });
        return;
      }
      if (order.status === OrderStatus.EXPIRED) {
        payment.processingStatus = PaymentProcessingStatus.REQUIRES_REVIEW;
        payment.reviewReason =
          remote.status === "approved"
            ? "LATE_APPROVED_AFTER_RELEASE"
            : "ORDER_EXPIRED_PROVIDER_UPDATE";
        await manager.save(payment);
        this.logger.warn({
          step: "payment_expired_order_update_requires_review",
          providerPaymentId: remote.id,
          orderId: order.id,
          status: remote.status,
          reviewReason: payment.reviewReason,
          processingResult: "REQUIRES_REVIEW",
        });
        if (order.kind === OrderKind.RAFFLE && remote.status === "approved")
          this.logger.warn({
            step: "raffle_payment_late_approved",
            providerPaymentId: remote.id,
            orderId: order.id,
            processingResult: "LATE_APPROVED_AFTER_RELEASE",
          });
        return;
      }
      const valid =
        remote.external_reference === order.id &&
        remote.currency_id === "ARS" &&
        mercadoPagoAmountToCents(remote.transaction_amount) ===
          order.totalInCents;
      if (!valid) {
        payment.processingStatus = PaymentProcessingStatus.REQUIRES_REVIEW;
        payment.reviewReason = "PAYMENT_VALIDATION_FAILED";
        await manager.save(payment);
        this.trace("payment_requires_review", {
          providerPaymentId: remote.id,
          orderId: order.id,
          processingResult: "REQUIRES_REVIEW",
        });
        return;
      }
      if (remote.status === "approved") {
        if (payment.processingStatus === PaymentProcessingStatus.APPLIED) {
          this.trace("payment_already_applied", {
            providerPaymentId: remote.id,
            orderId: order.id,
            processingResult: "APPLIED",
          });
          return;
        }
        let raffleAppliedLog: Record<string, unknown> | undefined;
        if (order.kind === OrderKind.RAFFLE) {
          this.trace("raffle_payment_settlement_started", {
            orderId: order.id,
            providerPaymentId: remote.id,
          });
          const settlement = await this.raffleLifecycle.commitSale(
            manager,
            order,
            remote.id,
          );
          if (!settlement.applied) {
            payment.processingStatus = PaymentProcessingStatus.REQUIRES_REVIEW;
            payment.reviewReason = settlement.reason;
            await manager.save(payment);
            return;
          }
          raffleAppliedLog = {
            orderId: order.id,
            raffleId: settlement.context.purchase.raffleId,
            rafflePurchaseId: settlement.context.purchase.id,
            providerPaymentId: remote.id,
            numbers: settlement.context.numbers.map((item) => item.number),
            numberCount: settlement.context.numbers.length,
            processingResult: "PAID",
          };
        } else {
          const items = await manager.findBy(OrderItem, { orderId: order.id });
          for (const item of items.sort((a, b) =>
            a.variantId.localeCompare(b.variantId),
          ))
            await this.inventory.commitSale(
              manager,
              item.variantId,
              item.quantity,
              order.id,
            );
        }
        order.status = OrderStatus.PAID;
        order.paidAt = new Date();
        payment.processingStatus = PaymentProcessingStatus.APPLIED;
        await manager.save([order, payment]);
        if (raffleAppliedLog)
          this.trace("raffle_payment_applied", raffleAppliedLog);
        else
          this.trace("payment_sale_applied", {
            providerPaymentId: remote.id,
            orderId: order.id,
            processingResult: "PAID",
          });
        return;
      }
      if (isProviderPending(remote.status)) {
        order.status = OrderStatus.PAYMENT_PENDING;
        payment.processingStatus = PaymentProcessingStatus.RECORDED;
        await manager.save([order, payment]);
        this.trace("payment_recorded_pending", {
          providerPaymentId: remote.id,
          orderId: order.id,
          processingResult: "PAYMENT_PENDING",
        });
        if (order.kind === OrderKind.RAFFLE)
          this.trace("raffle_payment_pending", {
            orderId: order.id,
            providerPaymentId: remote.id,
            processingResult: "PAYMENT_PENDING",
          });
        return;
      }
      payment.processingStatus = PaymentProcessingStatus.RECORDED;
      await manager.save(payment);
      this.trace("payment_recorded_non_terminal", {
        providerPaymentId: remote.id,
        orderId: order.id,
        processingResult: "RECORDED",
      });
    });
  }
  private date(value?: string) {
    return value ? new Date(value) : null;
  }

  @Cron("30 * * * * *")
  async earlyReconcilePendingOrders() {
    if (!this.config.enabled) return;
    const now = new Date();
    const cutoff = new Date(
      now.getTime() - this.config.earlyReconciliationIntervalSeconds * 1000,
    );
    const orders = await this.dataSource
      .getRepository(Order)
      .createQueryBuilder("order")
      .innerJoin(
        PaymentPreference,
        "preference",
        "preference.order_id = order.id AND preference.provider = :provider AND preference.status = :preferenceStatus",
        {
          provider: "mercado_pago",
          preferenceStatus: PaymentPreferenceStatus.READY,
        },
      )
      .leftJoin(
        Payment,
        "applied_payment",
        "applied_payment.order_id = order.id AND applied_payment.processing_status = :appliedStatus",
        { appliedStatus: PaymentProcessingStatus.APPLIED },
      )
      .where("order.status IN (:...statuses)", {
        statuses: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_PENDING],
      })
      .andWhere("order.created_at <= :cutoff", { cutoff })
      .andWhere("order.reservation_expires_at > :now", { now })
      .andWhere("applied_payment.id IS NULL")
      .andWhere(
        "(preference.last_reconciliation_at IS NULL OR preference.last_reconciliation_at <= :cutoff)",
        { cutoff },
      )
      .select("order.id", "id")
      .orderBy("order.created_at", "ASC")
      .take(25)
      .getRawMany<{ id: string }>();

    for (const { id: orderId } of orders) {
      this.trace("early_reconciliation_started", { orderId });
      try {
        const payments =
          await this.gateway.searchPaymentsByExternalReference(orderId);
        const approved = payments.find(
          (payment) => payment.status === "approved",
        );
        if (approved) await this.recordAndApply(approved);
        else if (payments.some((payment) => isProviderPending(payment.status)))
          for (const payment of payments) await this.recordAndApply(payment);
        await this.dataSource
          .getRepository(PaymentPreference)
          .update({ orderId }, { lastReconciliationAt: now });
        this.trace("early_reconciliation_finished", {
          orderId,
          processingResult: approved
            ? "APPROVED_FOUND"
            : payments.length
              ? "NO_APPROVED_PAYMENT"
              : "NO_PAYMENT",
        });
      } catch (error) {
        await this.dataSource
          .getRepository(PaymentPreference)
          .update({ orderId }, { lastReconciliationAt: now });
        this.logger.warn({
          step: "early_reconciliation_failed",
          orderId,
          errorCode: this.errorCode(error),
        });
      }
    }
  }

  @Cron("45 * * * * *") async reconcileExpiredReservations() {
    if (!this.config.enabled) return;
    const now = new Date();
    const cutoff = new Date(
      now.getTime() - this.config.reconciliationGraceSeconds * 1000,
    );
    const orders = await this.dataSource.getRepository(Order).find({
      where: {
        status: In([OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_PENDING]),
        reservationExpiresAt: LessThanOrEqual(cutoff),
      },
      take: 25,
      order: { reservationExpiresAt: "ASC" },
    });
    for (const order of orders) {
      try {
        const payments = await this.gateway.searchPaymentsByExternalReference(
          order.id,
        );
        const approved = payments.find(
          (payment) => payment.status === "approved",
        );
        if (approved) {
          await this.recordAndApply(approved);
          continue;
        }

        const hasPending = payments.some((payment) =>
          isProviderPending(payment.status),
        );
        for (const payment of payments) await this.recordAndApply(payment);

        const unresolvedKnownPending =
          order.status === OrderStatus.PAYMENT_PENDING && payments.length === 0;
        if (hasPending || unresolvedKnownPending) {
          const reviewDeadline = new Date(
            order.reservationExpiresAt.getTime() +
              this.config.pendingReviewHours * 3_600_000,
          );
          if (now < reviewDeadline) {
            this.trace("expired_pending_reconciliation_deferred", {
              orderId: order.id,
              processingResult: "PENDING_WITHIN_REVIEW_WINDOW",
            });
            continue;
          }
          this.logger.warn({
            step: "pending_review_deadline_reached",
            orderId: order.id,
            providerState: hasPending ? "PENDING" : "NOT_RETURNED",
            reviewDeadline: reviewDeadline.toISOString(),
            processingResult: "RELEASE_REQUIRES_REVIEW",
          });
          await this.expireReservation(
            order.id,
            true,
            hasPending
              ? "Mercado Pago pending review window elapsed"
              : "Mercado Pago no longer returned the known pending payment after the review window",
          );
          continue;
        }

        await this.expireReservation(
          order.id,
          false,
          payments.length
            ? "Mercado Pago confirmed a terminal non-approved payment"
            : "Mercado Pago confirmed no payment",
        );
      } catch (error) {
        this.logger.warn({
          step: "expired_reservation_reconciliation_deferred",
          orderId: order.id,
          errorCode: this.errorCode(error),
          processingResult: "PROVIDER_UNAVAILABLE_FAIL_CLOSED",
        });
      }
    }
  }

  private async expireReservation(
    orderId: string,
    markPendingForReview: boolean,
    reason: string,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager
        .createQueryBuilder(Order, "order")
        .setLock("pessimistic_write")
        .where("order.id = :orderId", { orderId })
        .getOne();
      if (
        !order ||
        (order.status !== OrderStatus.AWAITING_PAYMENT &&
          order.status !== OrderStatus.PAYMENT_PENDING)
      )
        return false;
      if (order.kind === OrderKind.RAFFLE) {
        const { purchase, numbers } =
          await this.raffleLifecycle.releaseReservation(manager, order);
        this.trace("raffle_payment_release", {
          orderId: order.id,
          raffleId: purchase.raffleId,
          rafflePurchaseId: purchase.id,
          numbers: numbers.map((item) => item.number),
          numberCount: numbers.length,
          processingResult: markPendingForReview
            ? "EXPIRED_REQUIRES_REVIEW"
            : "EXPIRED_CONFIRMED_UNPAID",
        });
      } else {
        const items = await manager.findBy(OrderItem, { orderId });
        for (const item of items.sort((a, b) =>
          a.variantId.localeCompare(b.variantId),
        ))
          await this.inventory.releaseReservation(
            manager,
            item.variantId,
            item.quantity,
            order.id,
            reason,
          );
      }

      if (markPendingForReview) {
        const pendingPayments = (
          await manager.findBy(Payment, { orderId: order.id })
        ).filter(
          (payment) =>
            payment.processingStatus !== PaymentProcessingStatus.APPLIED &&
            isProviderPending(payment.providerStatus),
        );
        for (const payment of pendingPayments) {
          payment.processingStatus = PaymentProcessingStatus.REQUIRES_REVIEW;
          payment.reviewReason = "PENDING_REVIEW_DEADLINE_REACHED";
        }
        if (pendingPayments.length) await manager.save(pendingPayments);
      }

      order.status = OrderStatus.EXPIRED;
      await manager.save(order);
      this.trace("expired_reservation_released", {
        orderId: order.id,
        reason,
        processingResult: markPendingForReview
          ? "EXPIRED_REQUIRES_REVIEW"
          : "EXPIRED_CONFIRMED_UNPAID",
      });
      return true;
    });
  }
}
