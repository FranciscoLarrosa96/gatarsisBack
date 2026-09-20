import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { Order } from "../../orders/entities/order.entity";
import { Raffle } from "./raffle.entity";
import { RaffleNumber } from "./raffle-number.entity";

export enum ManualRafflePaymentMethod {
  CASH = "CASH",
  TRANSFER = "TRANSFER",
  OTHER = "OTHER",
}

@Entity({ name: "raffle_purchases" })
@Index("IDX_raffle_purchases_raffle_created_at", ["raffleId", "createdAt"])
@Index("IDX_raffle_purchases_buyer_email_created_at", [
  "buyerEmail",
  "createdAt",
])
@Check("CHK_raffle_purchases_unit_price_positive", '"unit_price_in_cents" > 0')
export class RafflePurchase {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "raffle_id", type: "uuid" }) raffleId!: string;
  @ManyToOne(() => Raffle, (raffle) => raffle.purchases, {
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "raffle_id" })
  raffle!: Raffle;
  @Column({ name: "order_id", type: "uuid", unique: true }) orderId!: string;
  @OneToOne(() => Order, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "order_id" })
  order!: Order;
  @Column({ name: "buyer_name", type: "varchar", length: 160 })
  buyerName!: string;
  @Column({ name: "buyer_email", type: "varchar", length: 320, nullable: true })
  buyerEmail!: string | null;
  @Column({ name: "buyer_phone", type: "varchar", length: 80, nullable: true })
  buyerPhone!: string | null;
  @Column({ name: "unit_price_in_cents", type: "integer" })
  unitPriceInCents!: number;
  @Column({
    name: "manual_payment_method",
    type: "enum",
    enum: ManualRafflePaymentMethod,
    nullable: true,
  })
  manualPaymentMethod!: ManualRafflePaymentMethod | null;
  @Column({ name: "manual_payment_note", type: "varchar", length: 500, nullable: true })
  manualPaymentNote!: string | null;
  @OneToMany(() => RaffleNumber, (number) => number.rafflePurchase)
  numbers!: RaffleNumber[];
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
