import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { OrderItem } from "./order-item.entity";
export enum OrderStatus {
  AWAITING_PAYMENT = "AWAITING_PAYMENT",
  PAYMENT_PENDING = "PAYMENT_PENDING",
  PAID = "PAID",
  EXPIRED = "EXPIRED",
  CANCELLED = "CANCELLED",
  REFUNDED = "REFUNDED",
}
export enum OrderKind {
  MERCH = "MERCH",
  RAFFLE = "RAFFLE",
}
export enum OrderPaymentSource {
  MERCADO_PAGO = "MERCADO_PAGO",
  MANUAL = "MANUAL",
}
@Entity({ name: "orders" })
@Index(["status", "reservationExpiresAt"])
@Index(["kind", "status", "reservationExpiresAt"])
export class Order {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ type: "enum", enum: OrderKind, default: OrderKind.MERCH })
  kind!: OrderKind;
  @Column({ type: "enum", enum: OrderStatus }) status!: OrderStatus;
  @Column({
    name: "payment_source",
    type: "enum",
    enum: OrderPaymentSource,
    default: OrderPaymentSource.MERCADO_PAGO,
  })
  paymentSource!: OrderPaymentSource;
  @Column({ name: "idempotency_key", unique: true }) idempotencyKey!: string;
  @Column({ name: "request_fingerprint", type: "varchar", nullable: true })
  requestFingerprint!: string | null;
  @Column({ name: "subtotal_in_cents", type: "integer" })
  subtotalInCents!: number;
  @Column({ name: "total_in_cents", type: "integer" }) totalInCents!: number;
  @Column({ name: "reservation_expires_at", type: "timestamptz" })
  reservationExpiresAt!: Date;
  @Column({ name: "paid_at", type: "timestamptz", nullable: true })
  paidAt!: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
  @OneToMany(() => OrderItem, (item) => item.order) items!: OrderItem[];
}
