import { Transform, Type } from "class-transformer";
import {
  Equals,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

const singleLine = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;

const normalizedEmail = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim().toLowerCase() : value;

export enum HousingType {
  OWNED = "owned",
  RENTED = "rented",
  OTHER = "other",
}

export enum HomeSafetyStatus {
  PROTECTED = "protected",
  WILL_INSTALL = "will_install",
  NO = "no",
  NOT_APPLICABLE = "not_applicable",
}

export class AdoptionApplicantDto {
  @Transform(singleLine)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  fullName!: string;

  @Transform(normalizedEmail)
  @IsEmail()
  @MaxLength(160)
  email!: string;

  @Transform(singleLine)
  @IsString()
  @Matches(/^[0-9 +()\-]{6,40}$/)
  phone!: string;
}

export class AdoptionHomeDto {
  @IsBoolean()
  hasOtherPets!: boolean;

  @ValidateIf(
    (home: AdoptionHomeDto, value: unknown) =>
      home.hasOtherPets === true || value !== undefined,
  )
  @IsDefined()
  @IsBoolean()
  hasRegularVet?: boolean;

  @ValidateIf(
    (home: AdoptionHomeDto, value: unknown) =>
      home.hasOtherPets === true || value !== undefined,
  )
  @IsDefined()
  @IsBoolean()
  vaccinationsUpToDate?: boolean;

  @ValidateIf(
    (home: AdoptionHomeDto, value: unknown) =>
      home.hasOtherPets === true || value !== undefined,
  )
  @IsDefined()
  @IsBoolean()
  petsNeutered?: boolean;

  @IsBoolean()
  householdAgrees!: boolean;

  @IsEnum(HousingType)
  housingType!: HousingType;

  @ValidateIf(
    (home: AdoptionHomeDto, value: unknown) =>
      home.housingType === HousingType.RENTED || value !== undefined,
  )
  @IsDefined()
  @IsBoolean()
  rentalAllowsPets?: boolean;

  @IsBoolean()
  trustedCaregiver!: boolean;
}

export class AdoptionAdaptationDto {
  @IsBoolean()
  willingToSupportAdaptation!: boolean;
}

export class AdoptionCareDto {
  @IsBoolean()
  hasStableIncome!: boolean;

  @IsBoolean()
  canCoverVetEmergency!: boolean;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  previousPetsDeathContext!: string;
}

export class AdoptionSafetyDto {
  @IsEnum(HomeSafetyStatus)
  homeSafetyStatus!: HomeSafetyStatus;
}

export class AdoptionCommitmentsDto {
  @IsBoolean()
  acceptsMandatoryNeutering!: boolean;

  @IsBoolean()
  commitsNeuteringProof!: boolean;

  @IsBoolean()
  acceptsFollowUp!: boolean;

  @Equals(true)
  acceptsResponsibleReturnClause!: true;

  @Equals(true)
  acceptsLongTermCommitment!: true;
}

export class CreateAdoptionApplicationDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => AdoptionApplicantDto)
  applicant!: AdoptionApplicantDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => AdoptionHomeDto)
  home!: AdoptionHomeDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => AdoptionAdaptationDto)
  adaptation!: AdoptionAdaptationDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => AdoptionCareDto)
  care!: AdoptionCareDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => AdoptionSafetyDto)
  safety!: AdoptionSafetyDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => AdoptionCommitmentsDto)
  commitments!: AdoptionCommitmentsDto;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}
