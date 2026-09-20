import { MigrationInterface, QueryRunner } from "typeorm";

export class ManualRaffleSales1767484800000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "orders_payment_source_enum" AS ENUM ('MERCADO_PAGO', 'MANUAL')`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "payment_source" "orders_payment_source_enum" NOT NULL DEFAULT 'MERCADO_PAGO'`,
    );
    await queryRunner.query(
      `CREATE TYPE "raffle_purchases_manual_payment_method_enum" AS ENUM ('CASH', 'TRANSFER', 'OTHER')`,
    );
    await queryRunner.query(
      `ALTER TABLE "raffle_purchases" ALTER COLUMN "buyer_email" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "raffle_purchases" ALTER COLUMN "buyer_phone" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "raffle_purchases" ADD "manual_payment_method" "raffle_purchases_manual_payment_method_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "raffle_purchases" ADD "manual_payment_note" varchar(500)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "raffle_purchases" DROP COLUMN "manual_payment_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "raffle_purchases" DROP COLUMN "manual_payment_method"`,
    );
    await queryRunner.query(
      `UPDATE "raffle_purchases" SET "buyer_phone" = '' WHERE "buyer_phone" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "raffle_purchases" SET "buyer_email" = '' WHERE "buyer_email" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "raffle_purchases" ALTER COLUMN "buyer_phone" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "raffle_purchases" ALTER COLUMN "buyer_email" SET NOT NULL`,
    );
    await queryRunner.query(
      `DROP TYPE "raffle_purchases_manual_payment_method_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "payment_source"`);
    await queryRunner.query(`DROP TYPE "orders_payment_source_enum"`);
  }
}
