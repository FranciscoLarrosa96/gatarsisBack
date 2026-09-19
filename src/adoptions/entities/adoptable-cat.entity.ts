import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { AdoptionApplication } from "./adoption-application.entity";

export enum AdoptableCatSex {
  FEMALE = "FEMALE",
  MALE = "MALE",
}

export enum AdoptableCatStatus {
  AVAILABLE = "AVAILABLE",
  RESERVED = "RESERVED",
  PAUSED = "PAUSED",
  ADOPTED = "ADOPTED",
}

@Entity({ name: "adoptable_cats" })
@Index("IDX_adoptable_cats_public_order", [
  "published",
  "status",
  "displayOrder",
])
export class AdoptableCat {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ type: "varchar", length: 100 }) name!: string;
  @Column({ type: "enum", enum: AdoptableCatSex }) sex!: AdoptableCatSex;
  @Column({ name: "birth_date", type: "date", nullable: true })
  birthDate!: string | null;
  @Column({ name: "short_description", type: "varchar", length: 500 })
  shortDescription!: string;
  @Column({ name: "image_url", type: "text" }) imageUrl!: string;
  @Column({
    type: "enum",
    enum: AdoptableCatStatus,
    default: AdoptableCatStatus.AVAILABLE,
  })
  status!: AdoptableCatStatus;
  @Column({ default: false }) published!: boolean;
  @Column({ name: "display_order", type: "integer", default: 0 })
  displayOrder!: number;
  @OneToMany(() => AdoptionApplication, (application) => application.cat)
  applications!: AdoptionApplication[];
  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
