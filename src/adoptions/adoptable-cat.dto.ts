import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import {
  AdoptableCatSex,
  AdoptableCatStatus,
} from "./entities/adoptable-cat.entity";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class CreateAdoptableCatDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsEnum(AdoptableCatSex)
  sex!: AdoptableCatSex;

  @IsOptional()
  @IsDateString({ strict: true })
  birthDate?: string | null;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  shortDescription!: string;

  @Transform(trim)
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @MaxLength(2048)
  imageUrl!: string;

  @IsOptional()
  @IsEnum(AdoptableCatStatus)
  status?: AdoptableCatStatus;

  @IsOptional()
  @IsBoolean()
  published?: boolean;

  @IsOptional()
  @IsInt()
  @Min(-10_000)
  @Max(10_000)
  displayOrder?: number;
}

export class UpdateAdoptableCatDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsEnum(AdoptableCatSex)
  sex?: AdoptableCatSex;

  @IsOptional()
  @IsDateString({ strict: true })
  birthDate?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  shortDescription?: string;

  @IsOptional()
  @Transform(trim)
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @MaxLength(2048)
  imageUrl?: string;

  @IsOptional()
  @IsEnum(AdoptableCatStatus)
  status?: AdoptableCatStatus;

  @IsOptional()
  @IsBoolean()
  published?: boolean;

  @IsOptional()
  @IsInt()
  @Min(-10_000)
  @Max(10_000)
  displayOrder?: number;
}
