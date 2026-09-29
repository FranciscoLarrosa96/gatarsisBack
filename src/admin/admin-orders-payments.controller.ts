import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Patch,
  Query,
  Req,
} from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { Order, OrderStatus } from "../orders/entities/order.entity";
import { OrderItem } from "../orders/entities/order-item.entity";
import {
  Payment,
  PaymentProcessingStatus,
} from "../payments/entities/payment.entity";
import { PaymentPreference } from "../payments/entities/payment-preference.entity";
import { InventoryMovement } from "../inventory/entities/inventory-movement.entity";
import { AdminAuditLog } from "./entities/admin-audit-log.entity";
import { AdminRequest } from "./admin-auth.guard";
import { DomainError } from '../common/domain-error';
import { AdminOrderListQueryDto, AdminPaymentListQueryDto, AdminPaymentReviewListQueryDto, ResolveReviewDto } from './admin-orders-payments.dto';
import { toAdminMovement, toAdminOrderItem, toAdminOrderListItem, toAdminPaymentDetail, toAdminPaymentListItem, toAdminPreference } from './admin-orders-payments.responses';
import { RefundOperation } from '../payments/entities/refund-operation.entity';
import { FulfillmentStatus, OrderFulfillment } from '../orders/entities/order-fulfillment.entity';
import { RafflePurchase } from "../raffles/entities/raffle-purchase.entity";
import { Raffle } from "../raffles/entities/raffle.entity";
import { RaffleNumber } from "../raffles/entities/raffle-number.entity";
@Controller("admin")
export class AdminOrdersPaymentsController {
  constructor(private ds: DataSource) {}
  private page(q: any) {
    const p = Math.max(1, +q.page || 1),
      s = Math.min(100, Math.max(1, +q.pageSize || 20));
    return {
      p,
      s,
      pagination: (total: number) => ({
        page: p,
        pageSize: s,
        totalItems: total,
        totalPages: Math.ceil(total / s),
      }),
    };
  }
  private validateDateRange(q: { dateFrom?: string; dateTo?: string }) {
    if (q.dateFrom && q.dateTo && new Date(q.dateFrom) > new Date(q.dateTo)) throw new DomainError('INVALID_DATE_RANGE', 'dateFrom no puede ser posterior a dateTo.', undefined, 400);
  }
  @Get("orders") async orders(@Query() q: AdminOrderListQueryDto) {
    this.validateDateRange(q);
    const { p, s, pagination } = this.page(q);
    const qb = this.ds.getRepository(Order).createQueryBuilder("o");
    if (q.status) qb.andWhere("o.status=:status", { status: q.status });
    if (q.orderId) qb.andWhere("o.id=:id", { id: q.orderId });
    if (q.dateFrom) qb.andWhere("o.created_at >= :from", { from: q.dateFrom });
    if (q.dateTo) qb.andWhere("o.created_at <= :to", { to: q.dateTo });
    if (q.providerPaymentId)
      qb.innerJoin(Payment, "filter_payment", "filter_payment.order_id = o.id AND filter_payment.provider_payment_id = :providerPaymentId", { providerPaymentId: q.providerPaymentId });
    const [items, total] = await qb
      .orderBy("o.created_at", "DESC")
      .skip((p - 1) * s)
      .take(s)
      .getManyAndCount();
    const orderIds = items.map((order) => order.id);
    const [orderItems, fulfillments, rafflePurchases, payments] = orderIds.length
      ? await Promise.all([
          this.ds.getRepository(OrderItem).find({ where: { orderId: In(orderIds) }, order: { createdAt: "ASC" } }),
          this.ds.getRepository(OrderFulfillment).findBy({ orderId: In(orderIds) }),
          this.ds.getRepository(RafflePurchase).findBy({ orderId: In(orderIds) }),
          this.ds.getRepository(Payment).find({ where: { orderId: In(orderIds) }, order: { createdAt: "DESC" } }),
        ])
      : [[], [], [], []];
    const purchaseIds = rafflePurchases.map((purchase) => purchase.id);
    const raffleIds = [...new Set(rafflePurchases.map((purchase) => purchase.raffleId))];
    const [raffleNumbers, raffles] = purchaseIds.length
      ? await Promise.all([
          this.ds.getRepository(RaffleNumber).find({ where: { rafflePurchaseId: In(purchaseIds) }, order: { number: "ASC" } }),
          this.ds.getRepository(Raffle).findBy({ id: In(raffleIds) }),
        ])
      : [[], []];
    const itemsByOrder = new Map<string, { label: string; quantity: number }[]>();
    for (const item of orderItems) {
      const list = itemsByOrder.get(item.orderId) ?? [];
      list.push({
        label: [item.productNameSnapshot, item.variantNameSnapshot].filter(Boolean).join(" — "),
        quantity: item.quantity,
      });
      itemsByOrder.set(item.orderId, list);
    }
    const fulfillmentByOrder = new Map(fulfillments.map((item) => [item.orderId, item]));
    const purchaseByOrder = new Map(rafflePurchases.map((purchase) => [purchase.orderId, purchase]));
    const raffleById = new Map(raffles.map((raffle) => [raffle.id, raffle]));
    const numbersByPurchase = new Map<string, number[]>();
    for (const item of raffleNumbers) {
      if (!item.rafflePurchaseId) continue;
      const numbers = numbersByPurchase.get(item.rafflePurchaseId) ?? [];
      numbers.push(item.number);
      numbersByPurchase.set(item.rafflePurchaseId, numbers);
    }
    const paymentStatusByOrder = new Map<string, string>();
    for (const payment of payments)
      if (!paymentStatusByOrder.has(payment.orderId))
        paymentStatusByOrder.set(payment.orderId, payment.processingStatus);
    return {
      items: items.map((order) => {
        const purchase = purchaseByOrder.get(order.id);
        const fulfillment = fulfillmentByOrder.get(order.id);
        const raffle = purchase ? raffleById.get(purchase.raffleId) : undefined;
        return toAdminOrderListItem(
          order,
          (itemsByOrder.get(order.id) ?? []).reduce((sum, item) => sum + item.quantity, 0),
          {
            customer: purchase
              ? { name: purchase.buyerName, email: purchase.buyerEmail, phone: purchase.buyerPhone }
              : fulfillment
                ? { name: fulfillment.customerName, email: fulfillment.customerEmail, phone: fulfillment.customerPhone }
                : null,
            items: itemsByOrder.get(order.id) ?? [],
            raffle: purchase && raffle
              ? { title: raffle.title, numbers: numbersByPurchase.get(purchase.id) ?? [] }
              : null,
            paymentProcessingStatus: paymentStatusByOrder.get(order.id) ?? null,
          },
        );
      }),
      pagination: pagination(total),
    };
  }
  @Get("orders/:id") async order(@Param("id", new ParseUUIDPipe()) id: string) {
    const o = await this.ds
      .getRepository(Order)
      .findOne({ where: { id }, relations: { items: true } });
    if (!o) throw new NotFoundException({ code: "ORDER_NOT_FOUND" });
    const preference = await this.ds
        .getRepository(PaymentPreference)
        .findOneBy({ orderId: id });
    const payments = await this.ds.getRepository(Payment).findBy({ orderId: id });
    const movements = await this.ds
        .getRepository(InventoryMovement)
        .createQueryBuilder("m")
        .where("m.order_id=:id", { id })
        .getMany();
    const f=await this.ds.getRepository(OrderFulfillment).findOneBy({orderId:id});
    const rafflePurchase = await this.ds
      .getRepository(RafflePurchase)
      .findOneBy({ orderId: id });
    return { order: { id: o.id, kind: o.kind, status: o.status, paymentSource: o.paymentSource, totalInCents: o.totalInCents, createdAt: o.createdAt, reservationExpiresAt: o.reservationExpiresAt, paidAt: o.paidAt ?? null }, items: o.items.map(toAdminOrderItem), paymentPreference: toAdminPreference(preference), payments: payments.map(toAdminPaymentDetail), inventoryMovements: movements.map(toAdminMovement), fulfillment:f?{id:f.id,method:f.method,status:f.status,customer:{name:f.customerName,email:f.customerEmail,phone:f.customerPhone},customerNote:f.customerNote,adminNote:f.adminNote,readyAt:f.readyAt,completedAt:f.completedAt,createdAt:f.createdAt,updatedAt:f.updatedAt}:null, rafflePurchase:rafflePurchase?{id:rafflePurchase.id,raffleId:rafflePurchase.raffleId,buyer:{name:rafflePurchase.buyerName,email:rafflePurchase.buyerEmail,phone:rafflePurchase.buyerPhone},manualPaymentMethod:rafflePurchase.manualPaymentMethod,manualPaymentNote:rafflePurchase.manualPaymentNote}:null };
  }
  @Patch('orders/:id/fulfillment') async updateFulfillment(@Param('id',new ParseUUIDPipe())id:string,@Body()b:{status:FulfillmentStatus;adminNote?:string},@Req()r:AdminRequest){return this.ds.transaction(async m=>{const o=await m.findOneBy(Order,{id});const f=await m.findOneBy(OrderFulfillment,{orderId:id});if(!o)throw new NotFoundException({code:'ORDER_NOT_FOUND'});if(!f)throw new DomainError('FULFILLMENT_NOT_FOUND','Fulfillment inexistente.',undefined,404);if(o.status===OrderStatus.REFUNDED)throw new DomainError('FULFILLMENT_NOT_ALLOWED','No permitido.',undefined,409);const valid=(f.status===FulfillmentStatus.PENDING&&b.status===FulfillmentStatus.READY_FOR_PICKUP)||(f.status===FulfillmentStatus.READY_FOR_PICKUP&&b.status===FulfillmentStatus.COMPLETED);if(!valid)throw new DomainError('INVALID_FULFILLMENT_TRANSITION','Transición inválida.',undefined,409);if(b.status===FulfillmentStatus.READY_FOR_PICKUP&&o.status!==OrderStatus.PAID)throw new DomainError('ORDER_NOT_PAID','La orden no está pagada.',undefined,409);const previous=f.status;f.status=b.status;if(b.adminNote!==undefined)f.adminNote=b.adminNote.trim()||null;if(b.status===FulfillmentStatus.READY_FOR_PICKUP)f.readyAt=new Date();else f.completedAt=new Date();await m.save(f);await m.save(AdminAuditLog,{adminUserId:r.admin!.id,action:'FULFILLMENT_STATUS_CHANGED',entityType:'ORDER_FULFILLMENT',entityId:f.id,metadata:{orderId:id,fulfillmentId:f.id,previousStatus:previous,newStatus:f.status}});return {id:f.id,status:f.status,adminNote:f.adminNote,readyAt:f.readyAt,completedAt:f.completedAt};});}
  @Get("payments") async payments(@Query() q: AdminPaymentListQueryDto & { onlyUnresolvedReviews?: boolean }) {
    this.validateDateRange(q);
    const { p, s, pagination } = this.page(q);
    const qb = this.ds.getRepository(Payment).createQueryBuilder("p");
    if (q.processingStatus)
      qb.andWhere("p.processing_status=:x", { x: q.processingStatus });
    if (q.providerStatus)
      qb.andWhere("p.provider_status=:x", { x: q.providerStatus });
    if (q.orderId) qb.andWhere("p.order_id=:x", { x: q.orderId });
    if (q.providerPaymentId)
      qb.andWhere("p.provider_payment_id=:x", { x: q.providerPaymentId });
    if (q.dateFrom) qb.andWhere("p.created_at >= :from", { from: q.dateFrom });
    if (q.dateTo) qb.andWhere("p.created_at <= :to", { to: q.dateTo });
    if ((q as AdminPaymentListQueryDto & { onlyUnresolvedReviews?: boolean }).onlyUnresolvedReviews)
      qb.andWhere("p.review_resolved_at IS NULL");
    const [items, total] = await qb
      .orderBy("p.created_at", "DESC")
      .skip((p - 1) * s)
      .take(s)
      .getManyAndCount();
    return { items: items.map(toAdminPaymentListItem), pagination: pagination(total) };
  }
  @Get("payments/review") review(@Query() q: AdminPaymentReviewListQueryDto) {
    return this.payments({
      ...q,
      processingStatus: PaymentProcessingStatus.REQUIRES_REVIEW,
      onlyUnresolvedReviews: true,
    });
  }
  @Get("payments/:id") async payment(
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const p = await this.ds.getRepository(Payment).findOneBy({ id });
    if (!p) throw new NotFoundException({ code: "PAYMENT_NOT_FOUND" });
    const order = await this.ds.getRepository(Order).findOneBy({ id: p.orderId });
    const refund = await this.ds.getRepository(RefundOperation).findOne({ where: { paymentId: p.id }, order: { createdAt: 'DESC' } });
    return { payment: toAdminPaymentDetail(p), order: order ? { id: order.id, status: order.status, totalInCents: order.totalInCents, createdAt: order.createdAt, paidAt: order.paidAt ?? null } : null, refund: refund ? { id: refund.id, paymentId: refund.paymentId, orderId: refund.orderId, amountInCents: refund.amountInCents, status: refund.status, providerRefundId: refund.providerRefundId ?? null, createdAt: refund.createdAt, completedAt: refund.completedAt ?? null } : null };
  }
  @Post("payments/:id/review/resolve") async resolve(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() b: ResolveReviewDto,
    @Req() r: AdminRequest,
  ) {
    if (
      !b.note?.trim() ||
      !["ACKNOWLEDGED_NO_ACTION", "MANUAL_INVESTIGATION_COMPLETE"].includes(
        b.resolution,
      )
    )
      throw new DomainError("PAYMENT_REVIEW_NOT_ALLOWED", "La resolución de review no está permitida.", undefined, 409);
    return this.ds.transaction(async (m) => {
      const p = await m.findOneBy(Payment, { id });
      if (!p) throw new NotFoundException({ code: "PAYMENT_NOT_FOUND" });
      if (
        p.processingStatus !== PaymentProcessingStatus.REQUIRES_REVIEW ||
        p.reviewResolvedAt
      )
        throw new DomainError("PAYMENT_REVIEW_NOT_ALLOWED", "El pago no admite resolución de review.", undefined, 409);
      Object.assign(p, {
        reviewResolvedAt: new Date(),
        reviewResolvedByAdminId: r.admin!.id,
        reviewResolution: b.resolution,
        reviewNote: b.note.trim(),
      });
      await m.save(p);
      await m.save(AdminAuditLog, {
        adminUserId: r.admin!.id,
        action: "PAYMENT_REVIEW_RESOLVED",
        entityType: "PAYMENT",
        entityId: p.id,
        metadata: {
          paymentId: p.id,
          providerPaymentId: p.providerPaymentId,
          orderId: p.orderId,
          resolution: b.resolution,
        },
      });
      return toAdminPaymentDetail(p);
    });
  }
}
