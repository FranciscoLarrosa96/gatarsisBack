import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { AdminRequest } from "../admin/admin-auth.guard";
import {
  CreateManualRaffleSaleDto,
  CreateRaffleDto,
  DrawRaffleDto,
  RaffleListDto,
  RafflePurchasesListDto,
  UpdateRaffleDto,
} from "./raffles.dto";
import { RafflesService } from "./raffles.service";

@Controller("admin/raffles")
export class AdminRafflesController {
  constructor(private readonly raffles: RafflesService) {}

  @Post()
  create(@Body() dto: CreateRaffleDto, @Req() request: AdminRequest) {
    return this.raffles.create(dto, request.admin!.id);
  }

  @Post(":id/manual-sales")
  manualSale(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: CreateManualRaffleSaleDto,
    @Req() request: AdminRequest,
  ) {
    return this.raffles.manualSale(id, dto, request.admin!.id);
  }

  @Get()
  list(@Query() query: RaffleListDto) {
    return this.raffles.list(query);
  }

  @Get(":id")
  detail(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.raffles.detail(id);
  }

  @Patch(":id")
  update(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRaffleDto,
    @Req() request: AdminRequest,
  ) {
    return this.raffles.update(id, dto, request.admin!.id);
  }

  @Post(":id/publish")
  publish(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: AdminRequest,
  ) {
    return this.raffles.publish(id, request.admin!.id);
  }

  @Post(":id/pause")
  pause(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: AdminRequest,
  ) {
    return this.raffles.pause(id, request.admin!.id);
  }

  @Post(":id/resume")
  resume(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: AdminRequest,
  ) {
    return this.raffles.resume(id, request.admin!.id);
  }

  @Post(":id/close")
  close(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: AdminRequest,
  ) {
    return this.raffles.close(id, request.admin!.id);
  }

  @Post(":id/draw")
  draw(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: DrawRaffleDto,
    @Req() request: AdminRequest,
  ) {
    return this.raffles.draw(id, dto.winningNumber, request.admin!.id);
  }

  @Get(":id/numbers")
  numbers(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.raffles.numbers(id);
  }

  @Get(":id/purchases")
  purchases(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: RafflePurchasesListDto,
  ) {
    return this.raffles.purchases(id, query);
  }

  @Get(":id/purchases/:purchaseId")
  purchaseDetail(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("purchaseId", new ParseUUIDPipe()) purchaseId: string,
  ) {
    return this.raffles.purchaseDetail(id, purchaseId);
  }
}
