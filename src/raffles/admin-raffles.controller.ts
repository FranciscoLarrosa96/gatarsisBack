import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { Response } from "express";
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
import { RaffleExportsService } from "./raffle-exports.service";

@Controller("admin/raffles")
export class AdminRafflesController {
  constructor(
    private readonly raffles: RafflesService,
    private readonly exports: RaffleExportsService,
  ) {}

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

  @Delete(":id")
  @HttpCode(204)
  async remove(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: AdminRequest,
  ) {
    await this.raffles.remove(id, request.admin!.id);
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
    return this.raffles.draw(id, dto, request.admin!.id);
  }

  @Get(":id/draw-readiness")
  drawReadiness(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.raffles.drawReadiness(id);
  }

  @Get(":id/numbers")
  numbers(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.raffles.numbers(id);
  }

  @Get(":id/export/xlsx")
  async exportExcel(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.exportResponse(await this.exports.excel(id), response);
  }

  @Get(":id/export/pdf")
  async exportPdf(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.exportResponse(await this.exports.pdf(id), response);
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

  private exportResponse(
    file: { buffer: Buffer; contentType: string; filename: string },
    response: Response,
  ) {
    response.setHeader("Content-Type", file.contentType);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.filename}"`,
    );
    response.setHeader("Content-Length", String(file.buffer.length));
    return new StreamableFile(file.buffer);
  }
}
