import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import {
  ADOPTION_MAIL_CONFIG,
  ADOPTION_MAIL_TRANSPORT,
  adoptionMailConfig,
  AdoptionMailConfig,
} from "./adoption.config";
import { createAdoptionMailTransport } from "./adoption-mail.transport";
import { AdoptionsController } from "./adoptions.controller";
import { AdoptionsService } from "./adoptions.service";
import { AdminAdoptionsController } from "./admin-adoptions.controller";

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
  controllers: [AdoptionsController, AdminAdoptionsController],
  providers: [
    AdoptionsService,
    { provide: ADOPTION_MAIL_CONFIG, useFactory: adoptionMailConfig },
    {
      provide: ADOPTION_MAIL_TRANSPORT,
      inject: [ADOPTION_MAIL_CONFIG],
      useFactory: (config: AdoptionMailConfig) =>
        createAdoptionMailTransport(config),
    },
  ],
})
export class AdoptionsModule {}
