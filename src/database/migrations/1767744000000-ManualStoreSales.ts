import { MigrationInterface, QueryRunner } from "typeorm";

export class ManualStoreSales1767744000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE manual_payment_method_enum AS ENUM ('CASH', 'TRANSFER', 'OTHER')`,
    );
    await queryRunner.query(`ALTER TABLE orders
      ADD COLUMN manual_payment_method manual_payment_method_enum,
      ADD COLUMN manual_sale_note varchar(500)`);
    await queryRunner.query(`ALTER TABLE order_fulfillments
      ALTER COLUMN customer_email DROP NOT NULL,
      ALTER COLUMN customer_phone DROP NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Do not fabricate contact data when reverting sales with optional contacts.
    // PostgreSQL rejects this rollback if such records still exist.
    await queryRunner.query(`ALTER TABLE order_fulfillments
      ALTER COLUMN customer_email SET NOT NULL,
      ALTER COLUMN customer_phone SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE orders DROP COLUMN manual_sale_note, DROP COLUMN manual_payment_method`,
    );
    await queryRunner.query(`DROP TYPE manual_payment_method_enum`);
  }
}
