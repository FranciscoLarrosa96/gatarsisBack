import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  Min,
  MinLength,
  MaxLength,
} from "class-validator";
export class ProductDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) slug!: string;
  @IsOptional() @IsString() shortDescription?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() featured?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
}
export class ProductPatchDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() @MinLength(1) slug?: string;
  @IsOptional() @IsString() shortDescription?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() featured?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
}
export class VariantDto {
  @IsString() @MinLength(1) sku!: string;
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() @MaxLength(80) model?: string | null;
  @IsOptional() @IsString() @MaxLength(80) color?: string | null;
  @IsOptional() @IsString() @MaxLength(80) size?: string | null;
  @IsOptional() @IsObject() attributes?: Record<string, string>;
  @Type(() => Number) @IsInt() @Min(1) priceInCents!: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) lowStockThreshold?:
    | number
    | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) initialStock?: number;
}
export class VariantPatchDto {
  @IsOptional() @IsString() @MinLength(1) sku?: string;
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() @MaxLength(80) model?: string | null;
  @IsOptional() @IsString() @MaxLength(80) color?: string | null;
  @IsOptional() @IsString() @MaxLength(80) size?: string | null;
  @IsOptional() @IsObject() attributes?: Record<string, string>;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) priceInCents?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) lowStockThreshold?:
    | number
    | null;
}
export class MediaDto {
  @IsUrl({ require_tld: false }) url!: string;
  @IsString() @MinLength(1) alt!: string;
  @IsOptional() @IsUUID() variantId?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isCover?: boolean;
}
export class MediaPatchDto {
  @IsOptional() @IsUrl({ require_tld: false }) url?: string;
  @IsOptional() @IsString() @MinLength(1) alt?: string;
  @IsOptional() @IsUUID() variantId?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isCover?: boolean;
}
export class ProductListDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
  @IsOptional() @IsString() search?: string;
  @IsOptional()
  @Transform(({ value }) =>
    value === "true" || value === true
      ? true
      : value === "false" || value === false
        ? false
        : value,
  )
  @IsBoolean()
  active?: boolean;
  @IsOptional() @IsString() sort?: string;
}
