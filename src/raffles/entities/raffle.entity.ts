import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { AdminUser } from "../../admin/entities/admin-user.entity";
import { RaffleNumber } from "./raffle-number.entity";
import { RafflePurchase } from "./raffle-purchase.entity";

export enum RaffleStatus {
  DRAFT = "DRAFT",
  ACTIVE = "ACTIVE",
  PAUSED = "PAUSED",
  CLOSED = "CLOSED",
  DRAWN = "DRAWN",
}

@Entity({ name: "raffles" })
@Index("IDX_raffles_status_created_at", ["status", "createdAt"])
@Check("CHK_raffles_price_positive", '"price_in_cents" > 0')
@Check(
  "CHK_raffles_winning_number_range",
  '"winning_number" IS NULL OR ("winning_number" BETWEEN 0 AND 99)',
)
export class Raffle {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ type: "varchar", length: 160 }) title!: string;
  @Column({ name: "prize_name", type: "varchar", length: 160 })
  prizeName!: string;
  @Column({ type: "text", nullable: true }) description!: string | null;
  @Column({ name: "image_urls", type: "jsonb", default: () => "'[]'::jsonb" })
  imageUrls!: string[];
  @Column({ name: "price_in_cents", type: "integer" })
  priceInCents!: number;
  @Column({ type: "enum", enum: RaffleStatus, default: RaffleStatus.DRAFT })
  status!: RaffleStatus;
  @Column({ name: "draw_at", type: "timestamptz", nullable: true })
  drawAt!: Date | null;
  @Column({ name: "winning_number", type: "smallint", nullable: true })
  winningNumber!: number | null;
  @Column({ name: "drawn_at", type: "timestamptz", nullable: true })
  drawnAt!: Date | null;
  @Column({ name: "drawn_by_admin_id", type: "uuid", nullable: true })
  drawnByAdminId!: string | null;
  @ManyToOne(() => AdminUser, { nullable: true, onDelete: "RESTRICT" })
  @JoinColumn({ name: "drawn_by_admin_id" })
  drawnByAdmin!: AdminUser | null;
  @OneToMany(() => RaffleNumber, (number) => number.raffle)
  numbers!: RaffleNumber[];
  @OneToMany(() => RafflePurchase, (purchase) => purchase.raffle)
  purchases!: RafflePurchase[];
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
