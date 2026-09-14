export interface AdoptionMailConfig {
  enabled: boolean;
  mailTo: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

const requiredWhenEnabled = (
  environment: NodeJS.ProcessEnv,
  name: string,
): string => {
  const value = environment[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`ADOPTION_EMAIL_ENABLED=true but ${name} is missing`);
  }
  return value;
};

const emailWhenEnabled = (
  environment: NodeJS.ProcessEnv,
  name: string,
): string => {
  const value = requiredWhenEnabled(environment, name);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error(`${name} must be a valid email address`);
  }
  return value;
};

export const adoptionMailConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): AdoptionMailConfig => {
  const enabled = environment.ADOPTION_EMAIL_ENABLED === "true";
  const port = Number(environment.SMTP_PORT?.trim() || "465");
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535");
  }
  const secureValue = environment.SMTP_SECURE ?? "true";
  if (secureValue !== "true" && secureValue !== "false") {
    throw new Error("SMTP_SECURE must be true or false");
  }

  return {
    enabled,
    mailTo: enabled
      ? emailWhenEnabled(environment, "ADOPTION_MAIL_TO")
      : (environment.ADOPTION_MAIL_TO?.trim() ?? ""),
    host: enabled
      ? requiredWhenEnabled(environment, "SMTP_HOST")
      : (environment.SMTP_HOST?.trim() ?? "smtp.gmail.com"),
    port,
    secure: secureValue === "true",
    user: enabled
      ? emailWhenEnabled(environment, "SMTP_USER")
      : (environment.SMTP_USER?.trim() ?? ""),
    pass: enabled
      ? requiredWhenEnabled(environment, "SMTP_PASS")
      : (environment.SMTP_PASS ?? ""),
  };
};

export const ADOPTION_MAIL_CONFIG = Symbol("ADOPTION_MAIL_CONFIG");
export const ADOPTION_MAIL_TRANSPORT = Symbol("ADOPTION_MAIL_TRANSPORT");
