import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { Inventory } from "../../inventory/entities/inventory.entity";
import { Product } from "./product.entity";

@Entity({ name: "product_variants" })
export class ProductVariant {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "product_id", type: "uuid" }) productId!: string;
  @ManyToOne(() => Product, (product) => product.variants, {
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "product_id" })
  product!: Product;
  @Column({ unique: true }) sku!: string;
  @Column() name!: string;
  @Column({ type: "varchar", length: 80, nullable: true }) model!: string | null;
  @Column({ type: "varchar", nullable: true }) color!: string | null;
  @Column({ type: "varchar", nullable: true }) size!: string | null;
  @Column({ type: "jsonb", default: () => "'{}'" }) attributes!: Record<string, string>;
  @Column({ name: "price_in_cents", type: "integer" }) priceInCents!: number;
  @Column({ default: true }) active!: boolean;
  @Column({ name: 'sort_order', type: 'integer', default: 0 }) sortOrder!: number;
  @Column({ name: 'low_stock_threshold', type: 'integer', nullable: true }) lowStockThreshold!: number | null;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
  @OneToOne(() => Inventory, (inventory) => inventory.variant)
  inventory!: Inventory;
}
