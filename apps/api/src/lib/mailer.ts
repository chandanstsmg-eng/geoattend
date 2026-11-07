import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;

/** For tests that change the mail settings. */
export function resetMailer() {
  transport = null;
}

/** One mail connection for the process. The time limits stop a silent mail server holding up every job behind it. */
export function mailer() {
  return (transport ??= nodemailer.createTransport({ url: config.email.smtpUrl, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 } as any));
}
