import { INestApplication, Logger, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SendMailOptions } from "nodemailer";
import request = require("supertest");
import { ADOPTION_MAIL_TRANSPORT } from "../src/adoptions/adoption.config";
import { HomeSafetyStatus, HousingType } from "../src/adoptions/adoption.dto";
import { AdoptionMailTransport } from "../src/adoptions/adoption-mail.transport";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { MERCADO_PAGO_GATEWAY } from "../src/payments/mercado-pago.gateway";

class FakeTransport implements AdoptionMailTransport {
  readonly messages: SendMailOptions[] = [];
  error: Error | null = null;

  async sendMail(options: SendMailOptions): Promise<unknown> {
    if (this.error) throw this.error;
    this.messages.push(options);
    return { messageId: "test" };
  }
}

describe("adoption applications (e2e)", () => {
  let app: INestApplication;
  let transport: FakeTransport;
  let ds: DataSource;
  let ipCounter = 1;

  beforeAll(async () => {
    process.env.ADOPTION_EMAIL_ENABLED = "true";
    process.env.ADOPTION_MAIL_TO = "adoptions@example.com";
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    process.env.SMTP_USER = "sender@example.com";
    process.env.SMTP_PASS = "test-secret";
    jest.spyOn(Logger.prototype, "log").mockImplementation();

    transport = new FakeTransport();
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ADOPTION_MAIL_TRANSPORT)
      .useValue(transport)
      .overrideProvider(MERCADO_PAGO_GATEWAY)
      .useValue({
        createPreference: jest.fn(),
        searchPreferencesByExternalReference: jest.fn(),
        getPayment: jest.fn(),
        searchPaymentsByExternalReference: jest.fn(),
        refundPayment: jest.fn(),
        listRefunds: jest.fn(),
        validateWebhookSignature: jest.fn(),
      })
      .compile();

    app = module.createNestApplication();
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    ds = app.get(DataSource);
    await ds.runMigrations();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  beforeEach(async () => {
    await ds.query(
      "TRUNCATE adoption_applications, adoptable_cats, raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, refund_operations, webhook_events, inventory_movements, payments, payment_preferences, order_fulfillments, order_items, orders, inventory, product_media, product_variants, products RESTART IDENTITY CASCADE",
    );
    transport.messages.length = 0;
    transport.error = null;
  });

  it("accepts the frontend payload and sends to the server-controlled recipient", async () => {
    await post(validApplication()).expect(201).expect({ success: true });

    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]).toMatchObject({
      to: "adoptions@example.com",
      from: "Gatarsis Adopciones <sender@example.com>",
      replyTo: "ana@example.com",
      subject: "Nueva solicitud de adopción — Ana Pérez",
    });
    expect(transport.messages[0].html).toContain("CONTACTO");
    expect(transport.messages[0].text).toContain("HOGAR Y EXPERIENCIA");
  });

  it("rejects invalid email and missing required fields", async () => {
    const invalidEmail = validApplication();
    invalidEmail.applicant.email = "invalid";
    await post(invalidEmail).expect(400);

    const missingApplicant = validApplication() as Record<string, unknown>;
    delete missingApplicant.applicant;
    await post(missingApplicant).expect(400);
    expect(transport.messages).toHaveLength(0);
  });

  it("enforces conditional validation for other pets and rented homes", async () => {
    const otherPets = validApplication();
    otherPets.home.hasOtherPets = true;
    await post(otherPets).expect(400);

    const rental = validApplication();
    rental.home.housingType = HousingType.RENTED;
    await post(rental).expect(400);
    expect(transport.messages).toHaveLength(0);
  });

  it("rejects recipient and email markup fields supplied by the client", async () => {
    await post({
      ...validApplication(),
      to: "attacker@example.com",
      subject: "controlled by client",
      html: "<b>unsafe</b>",
    }).expect(400);
    expect(transport.messages).toHaveLength(0);
  });

  it("returns neutral success without sending when the honeypot is filled", async () => {
    await post({ ...validApplication(), website: "https://spam.example" })
      .expect(201)
      .expect({ success: true });
    expect(transport.messages).toHaveLength(0);
  });

  it("returns the stable 503 response and never exposes the SMTP error", async () => {
    transport.error = new Error("private SMTP failure detail");
    const response = await post(validApplication()).expect(503);

    expect(response.body).toMatchObject({
      code: "ADOPTION_APPLICATION_DELIVERY_FAILED",
    });
    expect(JSON.stringify(response.body)).not.toContain(
      "private SMTP failure detail",
    );
  });

  it("limits one origin to five requests per ten minutes", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      statuses.push((await post(validApplication(), "203.0.113.200")).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  function post(body: object, ip = `203.0.113.${ipCounter++}`) {
    return request(app.getHttpServer())
      .post("/api/v1/adoptions/applications")
      .set("X-Forwarded-For", ip)
      .send(body);
  }
});

function validApplication() {
  return {
    applicant: {
      fullName: "Ana Pérez",
      email: "ana@example.com",
      phone: "+54 249 4000000",
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
