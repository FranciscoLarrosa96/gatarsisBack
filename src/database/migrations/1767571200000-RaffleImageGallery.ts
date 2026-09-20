import { MigrationInterface, QueryRunner } from "typeorm";

export class RaffleImageGallery1767571200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "raffles" ADD "image_urls" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(
      `UPDATE "raffles" SET "image_urls" = jsonb_build_array("image_url") WHERE "image_url" IS NOT NULL AND btrim("image_url") <> ''`,
    );
    await queryRunner.query(`ALTER TABLE "raffles" DROP COLUMN "image_url"`);
    await queryRunner.query(
      `ALTER TABLE "raffles" ADD CONSTRAINT "CHK_raffles_image_urls" CHECK (jsonb_typeof("image_urls") = 'array' AND jsonb_array_length("image_urls") <= 8)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "raffles" DROP CONSTRAINT "CHK_raffles_image_urls"`,
    );
    await queryRunner.query(`ALTER TABLE "raffles" ADD "image_url" text`);
    await queryRunner.query(
      `UPDATE "raffles" SET "image_url" = "image_urls"->>0 WHERE jsonb_array_length("image_urls") > 0`,
    );
    await queryRunner.query(`ALTER TABLE "raffles" DROP COLUMN "image_urls"`);
  }
}
