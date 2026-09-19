import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { AdoptableCat } from "./adoptable-cat.entity";

@Entity({ name: "adoption_applications" })
@Index("IDX_adoption_applications_created_at", ["createdAt"])
@Index("IDX_adoption_applications_cat_id", ["adoptableCatId"])
export class AdoptionApplication {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ name: "adoptable_cat_id", type: "uuid", nullable: true })
  adoptableCatId!: string | null;
  @ManyToOne(() => AdoptableCat, (cat) => cat.applications, {
    nullable: true,
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "adoptable_cat_id" })
  cat!: AdoptableCat | null;
  @Column({ name: "application_data", type: "jsonb" })
  applicationData!: Record<string, unknown>;
  @Column({ name: "email_delivered", default: false })
  emailDelivered!: boolean;
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
