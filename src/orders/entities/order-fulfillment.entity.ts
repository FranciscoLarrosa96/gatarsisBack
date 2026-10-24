import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
export enum FulfillmentMethod {
  PICKUP = "PICKUP",
}
export enum FulfillmentStatus {
  PENDING = "PENDING",
  READY_FOR_PICKUP = "READY_FOR_PICKUP",
  COMPLETED = "COMPLETED",
}
@Entity({ name: "order_fulfillments" })
export class OrderFulfillment {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Index({ unique: true })
  @Column({ name: "order_id", type: "uuid" })
  orderId!: string;
  @Column({ type: "enum", enum: FulfillmentMethod }) method!: FulfillmentMethod;
  @Index()
  @Column({ type: "enum", enum: FulfillmentStatus })
  status!: FulfillmentStatus;
  @Column({ name: "customer_name" }) customerName!: string;
  @Column({ name: "customer_email", type: "varchar", nullable: true }) customerEmail!: string | null;
  @Column({ name: "customer_phone", type: "varchar", nullable: true }) customerPhone!: string | null;
  @Column({ name: "customer_note", type: "varchar", nullable: true })
  customerNote!: string | null;
  @Column({ name: "admin_note", type: "varchar", nullable: true }) adminNote!:
    | string
    | null;
  @Column({ name: "ready_at", type: "timestamptz", nullable: true })
  readyAt!: Date | null;
  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
