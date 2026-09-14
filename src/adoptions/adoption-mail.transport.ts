import { createTransport, SendMailOptions } from "nodemailer";
import { AdoptionMailConfig } from "./adoption.config";

export interface AdoptionMailTransport {
  sendMail(options: SendMailOptions): Promise<unknown>;
}

export const createAdoptionMailTransport = (
  config: AdoptionMailConfig,
): AdoptionMailTransport =>
  createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
