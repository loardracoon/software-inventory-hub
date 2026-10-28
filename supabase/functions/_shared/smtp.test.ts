import { describe, expect, it } from "vitest";
import { buildMessage, sendSmtp, smtpConfigFromEnv, type Conn, type SmtpConfig } from "./smtp.ts";

// A scripted SMTP server: answers each command with the next reply and records what the client wrote.
function fakeServer(replies: string[]) {
  const written: string[] = [];
  let pending = [replies.shift()!];
  let closed = false;
  const conn: Conn = {
    async read(p) {
      const next = pending.shift();
      if (next === undefined) return null;
      const bytes = new TextEncoder().encode(next);
      p.set(bytes);
      return bytes.length;
    },
    async write(p) {
      const line = new TextDecoder().decode(p);
      written.push(line);
      // DATA content ends with "\r\n.\r\n": one reply per command line.
      const reply = replies.shift();
      if (reply !== undefined) pending.push(reply);
      return p.length;
    },
    close() {
      closed = true;
    },
  };
  return { conn, written, isClosed: () => closed };
}

const mail = { to: ["admin@example.com", "ops@example.com"], subject: "Daily digest: 2 new title(s)", text: "Line 1\nCafé ✓" };
const config: SmtpConfig = { host: "mail.example.com", port: 465, user: "hub@example.com", pass: "s3cret", from: "hub@example.com" };

describe("SMTP client", () => {
  it("logs in, sends to every recipient and quits", async () => {
    const s = fakeServer(["220 ready\r\n", "250-mail.example.com\r\n250 AUTH PLAIN\r\n", "235 ok\r\n", "250 ok\r\n", "250 ok\r\n", "250 ok\r\n", "354 go\r\n", "250 queued\r\n", "221 bye\r\n"]);
    await sendSmtp(s.conn, config, mail, new Date("2026-10-28T12:00:00Z"));
    expect(s.written[0]).toBe("EHLO dictionary-hub\r\n");
    expect(s.written[1]).toBe(`AUTH PLAIN ${btoa("\0hub@example.com\0s3cret")}\r\n`);
    expect(s.written.slice(2, 5)).toEqual(["MAIL FROM:<hub@example.com>\r\n", "RCPT TO:<admin@example.com>\r\n", "RCPT TO:<ops@example.com>\r\n"]);
    expect(s.written[5]).toBe("DATA\r\n");
    expect(s.written[6]).toContain("Subject: Daily digest: 2 new title(s)\r\n");
    expect(s.written[6].endsWith("\r\n.\r\n")).toBe(true);
    expect(s.written.at(-1)).toBe("QUIT\r\n");
    expect(s.isClosed()).toBe(true);
  });

  it("skips the login without credentials (Mailpit)", async () => {
    const s = fakeServer(["220 ready\r\n", "250 ok\r\n", "250 ok\r\n", "250 ok\r\n", "354 go\r\n", "250 ok\r\n", "221 bye\r\n"]);
    await sendSmtp(s.conn, { ...config, port: 1025, user: null, pass: null }, { ...mail, to: ["a@example.com"] });
    expect(s.written.some((l) => l.startsWith("AUTH"))).toBe(false);
  });

  it("fails on a refused login and still closes the connection", async () => {
    const s = fakeServer(["220 ready\r\n", "250 ok\r\n", "535 5.7.8 authentication failed\r\n"]);
    await expect(sendSmtp(s.conn, config, mail)).rejects.toThrow(/expected 235, got "535/);
    expect(s.isClosed()).toBe(true);
  });

  it("builds a UTF-8 message; line breaks in the subject cannot add headers", () => {
    const m = buildMessage("hub@example.com", { ...mail, subject: "Hi\r\nBcc: evil@example.com" }, new Date("2026-10-28T12:00:00Z"), "1@example.com");
    expect(m).toContain("Subject: Hi Bcc: evil@example.com\r\n");
    expect(m).not.toMatch(/\r\nBcc:/);
    expect(m).toContain("Content-Transfer-Encoding: base64");
    const body = m.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))).toBe("Line 1\r\nCafé ✓");
    expect(buildMessage("a@b.c", { ...mail, subject: "Pausado: orçamento" }, new Date(), "x")).toContain("Subject: =?UTF-8?B?");
  });

  it("reads its configuration from the environment", () => {
    const env = (values: Record<string, string>) => (name: string) => values[name];
    expect(smtpConfigFromEnv(env({}))).toBeNull();
    expect(smtpConfigFromEnv(env({ SMTP_HOST: "mail.example.com", SMTP_USER: "hub@example.com", SMTP_PASS: "x" }))).toEqual({
      host: "mail.example.com",
      port: 465,
      user: "hub@example.com",
      pass: "x",
      from: "hub@example.com",
    });
    expect(smtpConfigFromEnv(env({ SMTP_HOST: "mailpit", SMTP_PORT: "1025", HUB_EMAIL_FROM: "hub@localhost" }))?.user).toBeNull();
  });
});
