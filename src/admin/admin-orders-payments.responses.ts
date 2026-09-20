import { InventoryMovement } from "../inventory/entities/inventory-movement.entity";
import { Order } from "../orders/entities/order.entity";
import { OrderItem } from "../orders/entities/order-item.entity";
import { Payment } from "../payments/entities/payment.entity";
import { PaymentPreference } from "../payments/entities/payment-preference.entity";

export type AdminOrderListItem = {
  id: string;
  kind: string;
  status: string;
  paymentSource: string;
  totalInCents: number;
  itemsCount: number;
  createdAt: Date;
  reservationExpiresAt: Date;
  paidAt: Date | null;
};
export type AdminPaymentListItem = {
  id: string;
  providerPaymentId: string;
  orderId: string;
  providerStatus: string;
  providerStatusDetail: string | null;
  processingStatus: string;
  transactionAmountInCents: number;
  currencyId: string;
  dateApproved: Date | null;
  createdAt: Date;
  reviewReason: string | null;
  reviewResolvedAt: Date | null;
  reviewResolution: string | null;
};
export type AdminPaymentDetailResponse = AdminPaymentListItem & {
  reviewResolvedByAdminId: string | null;
  reviewNote: string | null;
};

export const toAdminOrderListItem = (
  order: Order,
  itemsCount: number,
): AdminOrderListItem => ({
  id: order.id,
  kind: order.kind,
  status: order.status,
  paymentSource: order.paymentSource,
  totalInCents: order.totalInCents,
  itemsCount,
  createdAt: order.createdAt,
  reservationExpiresAt: order.reservationExpiresAt,
  paidAt: order.paidAt ?? null,
});
export const toAdminPaymentListItem = (
  payment: Payment,
): AdminPaymentListItem => ({
  id: payment.id,
  providerPaymentId: payment.providerPaymentId,
  orderId: payment.orderId,
  providerStatus: payment.providerStatus,
  providerStatusDetail: payment.providerStatusDetail ?? null,
  processingStatus: payment.processingStatus,
  transactionAmountInCents: payment.transactionAmountInCents,
  currencyId: payment.currencyId,
  dateApproved: payment.dateApproved ?? null,
  createdAt: payment.createdAt,
  reviewReason: payment.reviewReason ?? null,
  reviewResolvedAt: payment.reviewResolvedAt ?? null,
  reviewResolution: payment.reviewResolution ?? null,
});
export const toAdminPaymentDetail = (
  payment: Payment,
): AdminPaymentDetailResponse => ({
  ...toAdminPaymentListItem(payment),
  reviewResolvedByAdminId: payment.reviewResolvedByAdminId ?? null,
  reviewNote: payment.reviewNote ?? null,
});
export const toAdminOrderItem = (item: OrderItem) => ({
  id: item.id,
  productNameSnapshot: item.productNameSnapshot,
  variantNameSnapshot: item.variantNameSnapshot,
  skuSnapshot: item.skuSnapshot,
  quantity: item.quantity,
  unitPriceInCents: item.unitPriceInCents,
  lineTotalInCents: item.lineTotalInCents,
});
export const toAdminPreference = (preference: PaymentPreference | null) =>
  preference
    ? {
        id: preference.id,
        providerPreferenceId: preference.providerPreferenceId ?? null,
        status: preference.status,
        createdAt: preference.createdAt,
        readyAt: preference.readyAt ?? null,
      }
    : null;
export const toAdminMovement = (movement: InventoryMovement) => ({
  id: movement.id,
  variantId: movement.variantId,
  orderId: movement.orderId ?? null,
  type: movement.type,
  onHandDelta: movement.onHandDelta,
  reservedDelta: movement.reservedDelta,
  reason: movement.reason ?? null,
  createdAt: movement.createdAt,
});
