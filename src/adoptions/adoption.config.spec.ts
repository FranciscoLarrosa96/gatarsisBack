import { adoptionMailConfig } from "./adoption.config";

describe("adoptionMailConfig", () => {
  it("requires every SMTP secret and address when delivery is enabled", () => {
    expect(() =>
      adoptionMailConfig({ ADOPTION_EMAIL_ENABLED: "true" }),
    ).toThrow("ADOPTION_MAIL_TO is missing");
  });

  it("accepts a complete Gmail SMTP configuration", () => {
    expect(
      adoptionMailConfig({
        ADOPTION_EMAIL_ENABLED: "true",
        ADOPTION_MAIL_TO: "gatarsis2026@gmail.com",
        SMTP_HOST: "smtp.gmail.com",
        SMTP_PORT: "465",
        SMTP_SECURE: "true",
        SMTP_USER: "gatarsis2026@gmail.com",
        SMTP_PASS: "app-password",
      }),
    ).toEqual({
      enabled: true,
      mailTo: "gatarsis2026@gmail.com",
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      user: "gatarsis2026@gmail.com",
      pass: "app-password",
    });
  });

  it("rejects invalid ports, booleans and email addresses", () => {
    expect(() => adoptionMailConfig({ SMTP_PORT: "zero" })).toThrow(
      "SMTP_PORT",
    );
    expect(() => adoptionMailConfig({ SMTP_SECURE: "yes" })).toThrow(
      "SMTP_SECURE",
    );
    expect(() =>
      adoptionMailConfig({
        ADOPTION_EMAIL_ENABLED: "true",
        ADOPTION_MAIL_TO: "not-an-email",
      }),
    ).toThrow("ADOPTION_MAIL_TO must be a valid email address");
  });
});
