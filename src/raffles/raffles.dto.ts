import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ValidateIf,
} from "class-validator";
import { ManualRafflePaymentMethod } from "./entities/raffle-purchase.entity";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class CreateRaffleDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  prizeName!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2_000)
  description?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2_048)
  imageUrl?: string | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(2_048, { each: true })
  imageUrls?: string[];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  priceInCents!: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  drawAt?: string | null;
}

export class UpdateRaffleDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  prizeName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2_000)
  description?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2_048)
  imageUrl?: string | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(2_048, { each: true })
  imageUrls?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  priceInCents?: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  drawAt?: string | null;
}

export class RaffleListDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class DrawRaffleDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  winningNumber!: number;
}

export class RafflePurchasesListDto extends RaffleListDto {}

export class ManualRaffleBuyerDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(6)
  @MaxLength(80)
  whatsapp?: string;
}

export class CreateManualRaffleSaleDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(99, { each: true })
  numbers!: number[];

  @ValidateNested()
  @Type(() => ManualRaffleBuyerDto)
  buyer!: ManualRaffleBuyerDto;

  @IsEnum(ManualRafflePaymentMethod)
  paymentMethod!: ManualRafflePaymentMethod;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  @Transform(trim)
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  idempotencyKey!: string;
}
