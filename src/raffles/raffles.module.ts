import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { AdminRafflesController } from "./admin-raffles.controller";
import { RaffleReservationsController } from "./raffle-reservations.controller";
import { RaffleReservationsService } from "./raffle-reservations.service";
import { RaffleLifecycleService } from "./raffle-lifecycle.service";
import { RafflesService } from "./raffles.service";
import { PublicRafflesController } from "./public-raffles.controller";
import { PublicRafflesService } from "./public-raffles.service";
import { RaffleExportsService } from "./raffle-exports.service";

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
  controllers: [
    AdminRafflesController,
    PublicRafflesController,
    RaffleReservationsController,
  ],
  providers: [
    RafflesService,
    RaffleReservationsService,
    RaffleLifecycleService,
    PublicRafflesService,
    RaffleExportsService,
  ],
  exports: [RaffleLifecycleService],
})
export class RafflesModule {}
