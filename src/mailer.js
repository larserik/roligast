import nodemailer from "nodemailer";

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, SMTP_FROM } =
  process.env;

let transporter = null;
if (SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: SMTP_SECURE === "true",
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

const from = () => SMTP_FROM || "Roligast <info@roligast.com>";

// The mail follows the language the visitor is reading the site in.
const TEXTS = {
  sv: (pin) => ({
    subject: `${pin} är din inloggningskod till Roligast`,
    text: [
      `Din inloggningskod är: ${pin}`,
      "",
      "Koden är giltig i 10 minuter. Har du inte försökt logga in på roligast.com kan du ignorera det här mejlet.",
    ].join("\n"),
  }),
  en: (pin) => ({
    subject: `${pin} is your Roligast sign-in code`,
    text: [
      `Your sign-in code is: ${pin}`,
      "",
      "The code is valid for 10 minutes. If you did not try to sign in to roligast.com you can ignore this email.",
    ].join("\n"),
  }),
};

export async function sendPin(email, pin, lang = "sv") {
  const { subject, text } = (TEXTS[lang] || TEXTS.sv)(pin);

  if (!transporter) {
    // No SMTP configured (development): log the code instead.
    console.log(`[mailer] sign-in code for ${email}: ${pin}`);
    return;
  }
  await transporter.sendMail({ from: from(), to: email, subject, text });
}
