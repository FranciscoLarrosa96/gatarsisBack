import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { AdminRequest } from "../admin/admin-auth.guard";
import {
  CreateAdoptableCatDto,
  UpdateAdoptableCatDto,
} from "./adoptable-cat.dto";
import { AdoptionsService } from "./adoptions.service";

enum AdoptableCatAction {
  PUBLISH = "publish",
  PAUSE = "pause",
  RESERVE = "reserve",
  ADOPT = "adopt",
}

@Controller("admin/adoptions")
export class AdminAdoptionsController {
  constructor(private readonly adoptions: AdoptionsService) {}

  @Get("cats")
  cats() {
    return this.adoptions.adminCats();
  }

  @Post("cats")
  create(@Body() dto: CreateAdoptableCatDto, @Req() request: AdminRequest) {
    return this.adoptions.createCat(dto, request.admin!.id);
  }

  @Patch("cats/:id")
  update(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAdoptableCatDto,
    @Req() request: AdminRequest,
  ) {
    return this.adoptions.updateCat(id, dto, request.admin!.id);
  }

  @Post("cats/:id/:action")
  state(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("action", new ParseEnumPipe(AdoptableCatAction))
    action: AdoptableCatAction,
    @Req() request: AdminRequest,
  ) {
    return this.adoptions.setCatState(id, action, request.admin!.id);
  }

  @Get("applications")
  applications() {
    return this.adoptions.applications();
  }
}
