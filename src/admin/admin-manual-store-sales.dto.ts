import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { ManualPaymentMethod } from "../orders/manual-payment-method";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;
const optionalText = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() || null : value;

export class ManualStoreCustomerDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() || null : value,
  )
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string | null;

  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(80)
  phone?: string | null;
}

export class ManualStoreItemDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.toLowerCase() : value,
  )
  @IsUUID()
  variantId!: string;

  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  quantity!: number;
}

export class CreateManualStoreSaleDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => ManualStoreCustomerDto)
  customer!: ManualStoreCustomerDto;

  @IsEnum(ManualPaymentMethod)
  paymentMethod!: ManualPaymentMethod;

  @IsBoolean()
  @Equals(true, {
    message: "El pago debe estar recibido antes de registrar la venta.",
  })
  paymentReceived!: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((item: ManualStoreItemDto) => item?.variantId)
  @ValidateNested({ each: true })
  @Type(() => ManualStoreItemDto)
  items!: ManualStoreItemDto[];

  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @Transform(trim)
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  idempotencyKey!: string;
}
