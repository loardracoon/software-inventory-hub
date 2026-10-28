// Minimal SMTP client for the Hub's admin email: Mailu submission on 465 (implicit TLS, login) on the VPS,
// Mailpit on 1025 (plain, no login) in local development. The connection is injected, so Vitest drives the
// dialogue with a fake server; connectSmtp opens the real one in Deno.

export type SmtpConfig = { host: string; port: number; user: string | null; pass: string | null; from: string };
export type Mail = { to: string[]; subject: string; text: string };
export type Conn = { read(p: Uint8Array): Promise<number | null>; write(p: Uint8Array): Promise<number>; close(): void };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64(text: string): string {
  let binary = "";
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Header values: no line breaks (they would add headers); non-ASCII as an encoded word.
function header(value: string): string {
  const flat = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${base64(flat)}?=`;
}

// RFC 5322 message with a base64 UTF-8 body (no dot-stuffing or line-length issues).
export function buildMessage(from: string, mail: Mail, date: Date, messageId: string): string {
  const body = base64(mail.text.replace(/\r?\n/g, "\r\n")).replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: Dictionary Hub <${from}>`,
    `To: ${mail.to.join(", ")}`,
    `Subject: ${header(mail.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

class Replies {
  private buffer = "";
  constructor(private readonly conn: Conn) {}

  // One complete reply ("250-..." lines end with "250 ..."); throws unless its code is expected.
  async expect(...codes: number[]): Promise<string> {
    for (;;) {
      const lines = this.buffer.split("\r\n");
      const end = lines.findIndex((l) => /^\d{3} /.test(l));
      if (end >= 0) {
        const reply = lines.slice(0, end + 1).join("\n");
        this.buffer = lines.slice(end + 1).join("\r\n");
        const code = Number(lines[end].slice(0, 3));
        if (!codes.includes(code)) throw new Error(`SMTP: expected ${codes.join("/")}, got "${lines[end].slice(0, 120)}"`);
        return reply;
      }
      const chunk = new Uint8Array(4096);
      const n = await this.conn.read(chunk);
      if (n === null) throw new Error("SMTP: the server closed the connection");
      this.buffer += decoder.decode(chunk.subarray(0, n));
    }
  }
}

async function send(conn: Conn, line: string): Promise<void> {
  const bytes = encoder.encode(`${line}\r\n`);
  for (let off = 0; off < bytes.length; ) off += await conn.write(bytes.subarray(off));
}

export async function sendSmtp(conn: Conn, config: SmtpConfig, mail: Mail, now = new Date()): Promise<void> {
  const r = new Replies(conn);
  try {
    await r.expect(220);
    await send(conn, "EHLO dictionary-hub");
    await r.expect(250);
    if (config.user && config.pass) {
      await send(conn, `AUTH PLAIN ${base64(`\0${config.user}\0${config.pass}`)}`);
      await r.expect(235);
    }
    await send(conn, `MAIL FROM:<${config.from}>`);
    await r.expect(250);
    for (const to of mail.to) {
      await send(conn, `RCPT TO:<${to}>`);
      await r.expect(250, 251);
    }
    await send(conn, "DATA");
    await r.expect(354);
    const id = `${now.getTime()}.${Math.random().toString(36).slice(2)}@${config.from.split("@")[1] ?? "dictionary-hub"}`;
    await send(conn, `${buildMessage(config.from, mail, now, id)}\r\n.`);
    await r.expect(250);
    await send(conn, "QUIT");
    await r.expect(221).catch(() => undefined);
  } finally {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
}

// Port 465: implicit TLS (the certificate is checked). Other ports: plain TCP, only without a login,
// so a password never travels in clear (Mailpit in local development).
export async function connectSmtp(config: SmtpConfig): Promise<Conn> {
  if (config.port === 465) return await Deno.connectTls({ hostname: config.host, port: config.port });
  if (config.user || config.pass) throw new Error("SMTP login needs TLS: use port 465");
  return await Deno.connect({ hostname: config.host, port: config.port });
}

export function smtpConfigFromEnv(get: (name: string) => string | undefined): SmtpConfig | null {
  const host = get("SMTP_HOST");
  const from = get("HUB_EMAIL_FROM") || get("SMTP_USER");
  if (!host || !from) return null;
  return { host, port: Number(get("SMTP_PORT") || 465), user: get("SMTP_USER") || null, pass: get("SMTP_PASS") || null, from };
}
