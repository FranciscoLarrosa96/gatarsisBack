import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import { SendMailOptions } from "nodemailer";
import request = require("supertest");
import { DataSource, IsNull } from "typeorm";
import { AdminRole, AdminUser } from "../src/admin/entities/admin-user.entity";
import { AppModule } from "../src/app.module";
import { ADOPTION_MAIL_TRANSPORT } from "../src/adoptions/adoption.config";
import { HomeSafetyStatus, HousingType } from "../src/adoptions/adoption.dto";
import { AdoptionMailTransport } from "../src/adoptions/adoption-mail.transport";
import { AdoptionApplication } from "../src/adoptions/entities/adoption-application.entity";
import {
  AdoptableCat,
  AdoptableCatSex,
  AdoptableCatStatus,
} from "../src/adoptions/entities/adoptable-cat.entity";
import { MERCADO_PAGO_GATEWAY } from "../src/payments/mercado-pago.gateway";

class FakeMail implements AdoptionMailTransport {
  readonly messages: SendMailOptions[] = [];
  async sendMail(options: SendMailOptions) {
    this.messages.push(options);
    return { messageId: "test" };
  }
}

describe("adoptable cats and applications (PostgreSQL)", () => {
  let app: INestApplication;
  let ds: DataSource;
  let token: string;
  const mail = new FakeMail();

  beforeAll(async () => {
    process.env.DATABASE_NAME ??= "gatarsis_test";
    process.env.ADOPTION_EMAIL_ENABLED = "true";
    process.env.ADOPTION_MAIL_TO = "adoptions@example.test";
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    process.env.SMTP_USER = "sender@example.test";
    process.env.SMTP_PASS = "test-secret";
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ADOPTION_MAIL_TRANSPORT)
      .useValue(mail)
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

  afterAll(async () => app.close());

  beforeEach(async () => {
    await ds.query(
      "TRUNCATE adoption_applications, adoptable_cats, raffle_numbers, raffle_purchases, raffles, admin_audit_logs, admin_sessions, admin_users, refund_operations, webhook_events, inventory_movements, payments, payment_preferences, order_fulfillments, order_items, orders, inventory, product_media, product_variants, products RESTART IDENTITY CASCADE",
    );
    mail.messages.length = 0;
    const admin = await ds.getRepository(AdminUser).save({
      email: `${crypto.randomUUID()}@example.test`,
      passwordHash: await bcrypt.hash("CorrectHorseBatteryStaple!", 4),
      role: AdminRole.ADMIN,
      active: true,
      lastLoginAt: null,
    });
    token = (
      await request(app.getHttpServer())
        .post("/api/v1/admin/auth/login")
        .set("X-Forwarded-For", crypto.randomUUID())
        .send({
          email: admin.email,
          password: "CorrectHorseBatteryStaple!",
        })
        .expect(200)
    ).body.accessToken;
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function createCat(
    overrides: Record<string, unknown> = {},
  ): Promise<AdoptableCat> {
    return (
      await request(app.getHttpServer())
        .post("/api/v1/admin/adoptions/cats")
        .set(auth())
        .send({
          name: `Bianca ${crypto.randomUUID()}`,
          sex: AdoptableCatSex.FEMALE,
          birthDate: "2024-03-15",
          shortDescription: "Dulce, compañera y muy curiosa.",
          imageUrl:
            "https://res.cloudinary.com/demo/image/upload/adoptions/bianca.jpg",
          status: AdoptableCatStatus.AVAILABLE,
          published: true,
          displayOrder: 10,
          ...overrides,
        })
        .expect(201)
    ).body;
  }

  function submit(body: object) {
    return request(app.getHttpServer())
      .post("/api/v1/adoptions/applications")
      .set("X-Forwarded-For", crypto.randomUUID())
      .send(body);
  }

  it("lists only published AVAILABLE/RESERVED cats in stable display order without admin fields", async () => {
    const second = await createCat({ name: "Segundo", displayOrder: 2 });
    const first = await createCat({ name: "Primero", displayOrder: 1 });
    const reserved = await createCat({
      name: "En proceso",
      status: AdoptableCatStatus.RESERVED,
      displayOrder: 3,
    });
    await createCat({ name: "Pausado", status: AdoptableCatStatus.PAUSED });
    await createCat({ name: "Adoptado", status: AdoptableCatStatus.ADOPTED });
    await createCat({ name: "Oculto", published: false });

    const response = await request(app.getHttpServer())
      .get("/api/v1/adoptions/cats")
      .expect(200);
    expect(response.body.map((cat: AdoptableCat) => cat.id)).toEqual([
      first.id,
      second.id,
      reserved.id,
    ]);
    expect(response.body[0]).toEqual({
      id: first.id,
      name: "Primero",
      sex: AdoptableCatSex.FEMALE,
      birthDate: "2024-03-15",
      shortDescription: "Dulce, compañera y muy curiosa.",
      imageUrl:
        "https://res.cloudinary.com/demo/image/upload/adoptions/bianca.jpg",
      status: AdoptableCatStatus.AVAILABLE,
    });
    expect(JSON.stringify(response.body)).not.toContain("createdAt");
    expect(JSON.stringify(response.body)).not.toContain("published");
  });

  it("requires admin auth and validates creation data including HTTPS images", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/admin/adoptions/cats")
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .post("/api/v1/admin/adoptions/cats")
      .set(auth())
      .send({
        name: "Sin imagen segura",
        sex: AdoptableCatSex.MALE,
        shortDescription: "Descripción válida",
        imageUrl: "http://example.test/cat.jpg",
      })
      .expect(400);
    expect(await ds.getRepository(AdoptableCat).count()).toBe(0);
  });

  it("creates and edits a cat through the authenticated admin API", async () => {
    const cat = await createCat({ published: false });
    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/admin/adoptions/cats/${cat.id}`)
      .set(auth())
      .send({
        name: "Bianca editada",
        imageUrl: "https://res.cloudinary.com/demo/image/upload/new.jpg",
        displayOrder: 4,
      })
      .expect(200);
    expect(updated.body).toMatchObject({
      name: "Bianca editada",
      displayOrder: 4,
      published: false,
    });
  });

  it.each([
    ["publish", { published: true }],
    ["pause", { status: AdoptableCatStatus.PAUSED }],
    ["reserve", { status: AdoptableCatStatus.RESERVED }],
    ["adopt", { status: AdoptableCatStatus.ADOPTED }],
  ])("supports the admin %s quick action", async (action, expected) => {
    const cat = await createCat({ published: false });
    const response = await request(app.getHttpServer())
      .post(`/api/v1/admin/adoptions/cats/${cat.id}/${action}`)
      .set(auth())
      .expect(201);
    expect(response.body).toMatchObject(expected);
  });

  it("persists a valid application linked to the selected available cat", async () => {
    const cat = await createCat();
    await submit(validApplication(cat.id))
      .expect(201)
      .expect({ success: true });
    const saved = await ds
      .getRepository(AdoptionApplication)
      .findOneOrFail({ where: { adoptableCatId: cat.id } });
    expect(saved.applicationData).toMatchObject({
      applicant: { email: "ana@example.com" },
    });
    expect(saved.applicationData).not.toHaveProperty("website");
    expect(saved.emailDelivered).toBe(true);
    expect(mail.messages[0].text).toContain(cat.name);
  });

  it("rejects nonexistent and unavailable cat IDs without persisting or emailing", async () => {
    const missing = await submit(validApplication(crypto.randomUUID())).expect(
      404,
    );
    expect(missing.body.code).toBe("ADOPTABLE_CAT_NOT_FOUND");
    const adopted = await createCat({ status: AdoptableCatStatus.ADOPTED });
    const unavailable = await submit(validApplication(adopted.id)).expect(409);
    expect(unavailable.body.code).toBe("ADOPTABLE_CAT_UNAVAILABLE");
    expect(await ds.getRepository(AdoptionApplication).count()).toBe(0);
    expect(mail.messages).toHaveLength(0);
  });

  it("keeps the existing application flow working without a selected cat", async () => {
    await submit(validApplication()).expect(201).expect({ success: true });
    const saved = await ds
      .getRepository(AdoptionApplication)
      .findOneByOrFail({ adoptableCatId: IsNull() });
    expect(saved.applicationData).toMatchObject({
      applicant: { fullName: "Ana Pérez" },
    });
  });

  it("preserves the historical application association after marking the cat adopted", async () => {
    const cat = await createCat({ name: "Bianca histórica" });
    await submit(validApplication(cat.id)).expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/adoptions/cats/${cat.id}/adopt`)
      .set(auth())
      .expect(201);
    const applications = await request(app.getHttpServer())
      .get("/api/v1/admin/adoptions/applications")
      .set(auth())
      .expect(200);
    expect(applications.body).toHaveLength(1);
    expect(applications.body[0]).toMatchObject({
      adoptableCatId: cat.id,
      interest: {
        id: cat.id,
        name: "Bianca histórica",
        status: AdoptableCatStatus.ADOPTED,
      },
    });
  });
});

function validApplication(adoptableCatId?: string) {
  return {
    ...(adoptableCatId ? { adoptableCatId } : {}),
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
