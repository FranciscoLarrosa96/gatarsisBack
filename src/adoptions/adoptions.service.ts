import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { AdminAuditLog } from "../admin/entities/admin-audit-log.entity";
import { DomainError } from "../common/domain-error";
import {
  ADOPTION_MAIL_CONFIG,
  ADOPTION_MAIL_TRANSPORT,
  AdoptionMailConfig,
} from "./adoption.config";
import { CreateAdoptionApplicationDto } from "./adoption.dto";
import { renderAdoptionEmail } from "./adoption-email";
import { AdoptionMailTransport } from "./adoption-mail.transport";
import {
  CreateAdoptableCatDto,
  UpdateAdoptableCatDto,
} from "./adoptable-cat.dto";
import { AdoptionApplication } from "./entities/adoption-application.entity";
import {
  AdoptableCat,
  AdoptableCatStatus,
} from "./entities/adoptable-cat.entity";

@Injectable()
export class AdoptionsService {
  private readonly logger = new Logger(AdoptionsService.name);

  constructor(
    @Inject(ADOPTION_MAIL_CONFIG)
    private readonly config: AdoptionMailConfig,
    @Inject(ADOPTION_MAIL_TRANSPORT)
    private readonly transport: AdoptionMailTransport,
    private readonly dataSource: DataSource,
  ) {}

  async publicCats() {
    const cats = await this.dataSource.getRepository(AdoptableCat).find({
      where: {
        published: true,
        status: In([AdoptableCatStatus.AVAILABLE, AdoptableCatStatus.RESERVED]),
      },
      order: { displayOrder: "ASC", createdAt: "ASC", id: "ASC" },
    });
    return cats.map((cat) => this.publicCat(cat));
  }

  async adminCats() {
    return this.dataSource.getRepository(AdoptableCat).find({
      order: { displayOrder: "ASC", createdAt: "DESC", id: "ASC" },
    });
  }

  async createCat(dto: CreateAdoptableCatDto, adminId: string) {
    return this.dataSource.transaction(async (manager) => {
      const cat = await manager.save(AdoptableCat, {
        ...dto,
        birthDate: dto.birthDate ?? null,
        status: dto.status ?? AdoptableCatStatus.AVAILABLE,
        published: dto.published ?? false,
        displayOrder: dto.displayOrder ?? 0,
      });
      await manager.save(AdminAuditLog, {
        adminUserId: adminId,
        action: "ADOPTABLE_CAT_CREATED",
        entityType: "ADOPTABLE_CAT",
        entityId: cat.id,
        metadata: { status: cat.status, published: cat.published },
      });
      return cat;
    });
  }

  async updateCat(id: string, dto: UpdateAdoptableCatDto, adminId: string) {
    return this.dataSource.transaction(async (manager) => {
      const cat = await manager.findOneBy(AdoptableCat, { id });
      if (!cat) this.catNotFound();
      Object.assign(cat, dto);
      await manager.save(cat);
      await manager.save(AdminAuditLog, {
        adminUserId: adminId,
        action: "ADOPTABLE_CAT_UPDATED",
        entityType: "ADOPTABLE_CAT",
        entityId: cat.id,
        metadata: { changedFields: Object.keys(dto) },
      });
      return manager.findOneByOrFail(AdoptableCat, { id });
    });
  }

  async setCatState(
    id: string,
    action: "publish" | "pause" | "reserve" | "adopt",
    adminId: string,
  ) {
    const patch: UpdateAdoptableCatDto =
      action === "publish"
        ? { published: true }
        : {
            status: {
              pause: AdoptableCatStatus.PAUSED,
              reserve: AdoptableCatStatus.RESERVED,
              adopt: AdoptableCatStatus.ADOPTED,
            }[action],
          };
    return this.updateCat(id, patch, adminId);
  }

  async applications() {
    const applications = await this.dataSource
      .getRepository(AdoptionApplication)
      .find({ relations: { cat: true }, order: { createdAt: "DESC" } });
    return applications.map((application) => ({
      id: application.id,
      adoptableCatId: application.adoptableCatId,
      interest: application.cat ? this.publicCat(application.cat) : null,
      application: application.applicationData,
      emailDelivered: application.emailDelivered,
      createdAt: application.createdAt,
    }));
  }

  async submit(
    application: CreateAdoptionApplicationDto,
    requestId: string,
  ): Promise<{ success: true }> {
    this.log("adoption_application_received", requestId, "received");

    if (application.website?.trim()) {
      return { success: true };
    }

    let cat: AdoptableCat | null = null;
    if (application.adoptableCatId) {
      cat = await this.dataSource.getRepository(AdoptableCat).findOneBy({
        id: application.adoptableCatId,
      });
      if (!cat) this.catNotFound();
      if (!cat.published || cat.status !== AdoptableCatStatus.AVAILABLE)
        throw new DomainError(
          "ADOPTABLE_CAT_UNAVAILABLE",
          "El michi seleccionado no está disponible para nuevas solicitudes.",
        );
    }

    if (!this.config.enabled) {
      this.log(
        "adoption_application_delivery_failed",
        requestId,
        "email_disabled",
      );
      throw this.deliveryError();
    }

    const { website: _website, ...applicationData } = application;
    const saved = await this.dataSource
      .getRepository(AdoptionApplication)
      .save({
        adoptableCatId: cat?.id ?? null,
        applicationData,
        emailDelivered: false,
      });
    const { html, text } = renderAdoptionEmail(application, cat?.name);
    try {
      await this.transport.sendMail({
        from: `Gatarsis Adopciones <${this.config.user}>`,
        to: this.config.mailTo,
        replyTo: application.applicant.email,
        subject: `Nueva solicitud de adopción — ${application.applicant.fullName}`,
        html,
        text,
      });
      await this.dataSource
        .getRepository(AdoptionApplication)
        .update({ id: saved.id }, { emailDelivered: true });
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

  private publicCat(cat: AdoptableCat) {
    return {
      id: cat.id,
      name: cat.name,
      sex: cat.sex,
      birthDate: cat.birthDate,
      shortDescription: cat.shortDescription,
      imageUrl: cat.imageUrl,
      status: cat.status,
    };
  }

  private catNotFound(): never {
    throw new NotFoundException({
      code: "ADOPTABLE_CAT_NOT_FOUND",
      message: "El michi seleccionado no existe.",
    });
  }
}
