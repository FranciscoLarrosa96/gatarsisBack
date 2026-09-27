import { MigrationInterface, QueryRunner } from "typeorm";

export class VariantModel1767657600000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE product_variants ADD COLUMN model varchar(80)');
    // No legacy combinations are rewritten or deleted. Model-bearing variants
    // get a NULL-safe, case-insensitive database identity.
    await q.query(`CREATE UNIQUE INDEX "UQ_variant_model_combination"
      ON product_variants (product_id, lower(btrim(model)),
        coalesce(lower(btrim(color)), ''), coalesce(lower(btrim(size)), ''))
      WHERE model IS NOT NULL`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX "UQ_variant_model_combination"');
    await q.query('ALTER TABLE product_variants DROP COLUMN model');
  }
}
