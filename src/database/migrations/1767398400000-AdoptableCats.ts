import { MigrationInterface, QueryRunner } from "typeorm";

export class AdoptableCats1767398400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "adoptable_cats_sex_enum" AS ENUM ('FEMALE', 'MALE')`,
    );
    await queryRunner.query(
      `CREATE TYPE "adoptable_cats_status_enum" AS ENUM ('AVAILABLE', 'RESERVED', 'PAUSED', 'ADOPTED')`,
    );
    await queryRunner.query(`
      CREATE TABLE "adoptable_cats" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar(100) NOT NULL,
        "sex" "adoptable_cats_sex_enum" NOT NULL,
        "birth_date" date,
        "short_description" varchar(500) NOT NULL,
        "image_url" text NOT NULL,
        "status" "adoptable_cats_status_enum" NOT NULL DEFAULT 'AVAILABLE',
        "published" boolean NOT NULL DEFAULT false,
        "display_order" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_adoptable_cats" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_adoptable_cats_public_order" ON "adoptable_cats" ("published", "status", "display_order")`,
    );
    await queryRunner.query(`
      CREATE TABLE "adoption_applications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "adoptable_cat_id" uuid,
        "application_data" jsonb NOT NULL,
        "email_delivered" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_adoption_applications" PRIMARY KEY ("id"),
        CONSTRAINT "FK_adoption_applications_cat" FOREIGN KEY ("adoptable_cat_id") REFERENCES "adoptable_cats"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_adoption_applications_created_at" ON "adoption_applications" ("created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_adoption_applications_cat_id" ON "adoption_applications" ("adoptable_cat_id")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "adoption_applications"`);
    await queryRunner.query(`DROP TABLE "adoptable_cats"`);
    await queryRunner.query(`DROP TYPE "adoptable_cats_status_enum"`);
    await queryRunner.query(`DROP TYPE "adoptable_cats_sex_enum"`);
  }
}
