import { Logger } from "@nestjs/common";
import { SendMailOptions } from "nodemailer";
import { DomainError } from "../common/domain-error";
import { AdoptionMailConfig } from "./adoption.config";
import {
  CreateAdoptionApplicationDto,
  HomeSafetyStatus,
  HousingType,
} from "./adoption.dto";
import { AdoptionMailTransport } from "./adoption-mail.transport";
import { AdoptionsService } from "./adoptions.service";
import { DataSource } from "typeorm";

class FakeTransport implements AdoptionMailTransport {
  readonly messages: SendMailOptions[] = [];
  error: Error | null = null;

  async sendMail(options: SendMailOptions): Promise<unknown> {
    if (this.error) throw this.error;
    this.messages.push(options);
    return { messageId: "test" };
  }
}

describe("AdoptionsService", () => {
  let transport: FakeTransport;
  let service: AdoptionsService;
  let log: jest.SpyInstance;

  beforeEach(() => {
    transport = new FakeTransport();
    service = new AdoptionsService(
      enabledConfig(),
      transport,
      fakeDataSource(),
    );
    log = jest.spyOn(Logger.prototype, "log").mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it("uses the configured recipient and applicant reply-to", async () => {
    await expect(
      service.submit(validApplication(), "request-1"),
    ).resolves.toEqual({
      success: true,
    });

    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]).toMatchObject({
      from: "Gatarsis Adopciones <sender@example.com>",
      to: "adoptions@example.com",
      replyTo: "ana@example.com",
      subject: "Nueva solicitud de adopción — Ana Pérez",
    });
    const logs = JSON.stringify(log.mock.calls);
    expect(logs).not.toContain("Ana Pérez");
    expect(logs).not.toContain("ana@example.com");
    expect(logs).toContain("adoption_application_sent");
  });

  it("returns a neutral success and does not send mail for honeypot submissions", async () => {
    const application = validApplication();
    application.website = "spam.example";

    await expect(service.submit(application, "request-2")).resolves.toEqual({
      success: true,
    });
    expect(transport.messages).toHaveLength(0);
  });

  it("maps SMTP errors to the stable 503 domain error", async () => {
    transport.error = new Error("credentials must remain private");

    await expect(
      service.submit(validApplication(), "request-3"),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "ADOPTION_APPLICATION_DELIVERY_FAILED",
    });
    await service
      .submit(validApplication(), "request-4")
      .catch((error: DomainError) => {
        expect(error.getStatus()).toBe(503);
      });
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "credentials must remain private",
    );
  });

  it("fails safely instead of accepting an application while email is disabled", async () => {
    service = new AdoptionsService(
      { ...enabledConfig(), enabled: false },
      transport,
      fakeDataSource(),
    );

    await expect(
      service.submit(validApplication(), "request-5"),
    ).rejects.toMatchObject({
      code: "ADOPTION_APPLICATION_DELIVERY_FAILED",
    });
    expect(transport.messages).toHaveLength(0);
  });
});

function enabledConfig(): AdoptionMailConfig {
  return {
    enabled: true,
    mailTo: "adoptions@example.com",
    host: "smtp.example.com",
    port: 465,
    secure: true,
    user: "sender@example.com",
    pass: "test-secret",
  };
}

function fakeDataSource(): DataSource {
  return {
    getRepository: () => ({
      save: jest.fn().mockResolvedValue({ id: "application-id" }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    }),
  } as unknown as DataSource;
}

function validApplication(): CreateAdoptionApplicationDto {
  return {
    applicant: {
      fullName: "Ana Pérez",
      email: "ana@example.com",
      phone: "2494000000",
    },
    home: {
      hasOtherPets: false,
      householdAgrees: true,
      housingType: HousingType.OWNED,
      trustedCaregiver: true,
    },
    adaptation: { willingToSupportAdaptation: true },
    care: {
      hasStableIncome: true,
      canCoverVetEmergency: true,
      previousPetsDeathContext: "No tuve mascotas anteriormente.",
    },
    safety: { homeSafetyStatus: HomeSafetyStatus.PROTECTED },
    commitments: {
      acceptsMandatoryNeutering: true,
      commitsNeuteringProof: true,
      acceptsFollowUp: true,
      acceptsResponsibleReturnClause: true,
      acceptsLongTermCommitment: true,
    },
    website: "",
  };
}
