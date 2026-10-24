import { Body, Controller, Post, Req } from "@nestjs/common";
import { AdminRequest } from "./admin-auth.guard";
import { CreateManualStoreSaleDto } from "./admin-manual-store-sales.dto";
import { AdminManualStoreSalesService } from "./admin-manual-store-sales.service";

@Controller("admin/orders")
export class AdminManualStoreSalesController {
  constructor(private readonly sales: AdminManualStoreSalesService) {}

  @Post("manual")
  create(@Body() dto: CreateManualStoreSaleDto, @Req() request: AdminRequest) {
    return this.sales.create(dto, request.admin!.id);
  }
}
