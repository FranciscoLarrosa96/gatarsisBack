import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { randomUUID } from "crypto";
import { CreateAdoptionApplicationDto } from "./adoption.dto";
import { AdoptionsService } from "./adoptions.service";

const ADOPTION_RATE_LIMIT = 5;
const ADOPTION_RATE_WINDOW_MS = 10 * 60_000;

@Controller("adoptions")
export class AdoptionsController {
  constructor(private readonly adoptions: AdoptionsService) {}

  @Post("applications")
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: {
      limit: ADOPTION_RATE_LIMIT,
      ttl: ADOPTION_RATE_WINDOW_MS,
    },
  })
  submit(@Body() application: CreateAdoptionApplicationDto) {
    return this.adoptions.submit(application, randomUUID());
  }
}
