import { Inject, Injectable, Logger } from "@nestjs/common";
import { DomainError } from "../common/domain-error";
import {
  ADOPTION_MAIL_CONFIG,
  ADOPTION_MAIL_TRANSPORT,
  AdoptionMailConfig,
} from "./adoption.config";
import { CreateAdoptionApplicationDto } from "./adoption.dto";
import { renderAdoptionEmail } from "./adoption-email";
import { AdoptionMailTransport } from "./adoption-mail.transport";

@Injectable()
export class AdoptionsService {
  private readonly logger = new Logger(AdoptionsService.name);

  constructor(
    @Inject(ADOPTION_MAIL_CONFIG)
    private readonly config: AdoptionMailConfig,
    @Inject(ADOPTION_MAIL_TRANSPORT)
    private readonly transport: AdoptionMailTransport,
  ) {}

  async submit(
    application: CreateAdoptionApplicationDto,
    requestId: string,
  ): Promise<{ success: true }> {
    this.log("adoption_application_received", requestId, "received");

    if (application.website?.trim()) {
      return { success: true };
    }

    if (!this.config.enabled) {
      this.log(
        "adoption_application_delivery_failed",
        requestId,
        "email_disabled",
      );
      throw this.deliveryError();
    }

    const { html, text } = renderAdoptionEmail(application);
    try {
      await this.transport.sendMail({
        from: `Gatarsis Adopciones <${this.config.user}>`,
        to: this.config.mailTo,
        replyTo: application.applicant.email,
        subject: `Nueva solicitud de adopción — ${application.applicant.fullName}`,
        html,
        text,
      });
      this.log("adoption_application_sent", requestId, "sent");
      return { success: true };
    } catch {
      this.log("adoption_application_delivery_failed", requestId, "smtp_error");
      throw this.deliveryError();
    }
  }

  private log(event: string, requestId: string, result: string): void {
    this.logger.log({ event, requestId, result });
  }

  private deliveryError(): DomainError {
    return new DomainError(
      "ADOPTION_APPLICATION_DELIVERY_FAILED",
      "No pudimos entregar la solicitud de adopción.",
      undefined,
      503,
    );
  }
}
