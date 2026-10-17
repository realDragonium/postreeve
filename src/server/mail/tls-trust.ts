import { X509Certificate } from "node:crypto";
import { isIP, Socket, connect as connectTcp } from "node:net";
import { connect as connectTls, rootCertificates, type ConnectionOptions, type PeerCertificate, type TLSSocket } from "node:tls";
import { z } from "zod";
import type { PresentedCertificate } from "../../shared/contracts";

/** A server certificate the owner trusts explicitly, pinned by its exact SHA-256 fingerprint. */
export const tlsPinSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  certificate: z.string().min(1).max(64_000),
});
export type TlsPin = z.infer<typeof tlsPinSchema>;

export interface TlsEndpoint {
  readonly protocol: "imap" | "smtp";
  readonly host: string;
  readonly port: number;
  /** True for implicit TLS (993, 465); false upgrades with STARTTLS. */
  readonly secure: boolean;
}

export type InspectCertificate = (endpoint: TlsEndpoint) => Promise<PresentedCertificate & { pem: string }>;

const pinMismatchCode = "CERT_PIN_MISMATCH";

/** Errors OpenSSL and Node report when a certificate cannot be verified, plus a pin mismatch. */
const certificateErrorCodes = new Set([
  pinMismatchCode,
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

export function normalizeFingerprint(value: string): string {
  return value.replace(/[:\s]/g, "").toLowerCase();
}

/**
 * TLS options that trust exactly the pinned certificate: it is added as a trust anchor next to the public
 * roots, so a self-signed or IP-addressed server verifies, and the fingerprint check replaces the host-name
 * check. Verification stays on; any other certificate fails.
 */
export function pinnedTlsOptions(pin: TlsPin | undefined): { tls?: ConnectionOptions } {
  if (!pin) return {};
  return {
    tls: {
      ca: [...rootCertificates, pin.certificate],
      checkServerIdentity: (_host: string, certificate: PeerCertificate) => {
        if (normalizeFingerprint(certificate.fingerprint256) === pin.fingerprint) return undefined;
        return Object.assign(new Error("The server's certificate no longer matches the trusted certificate"), { code: pinMismatchCode });
      },
    },
  };
}

/**
 * ImapFlow passes `servername: false` for an IP host, which Bun rejects, so an IMAP server reached by a LAN or
 * tailnet address never connected. Clearing it lets Node and Bun skip SNI for IP addresses themselves.
 */
export function imapTlsOptions(host: string, pin: TlsPin | undefined): { tls?: ConnectionOptions } {
  const pinned = pinnedTlsOptions(pin);
  if (!isIP(host)) return pinned;
  return { tls: { ...pinned.tls, servername: undefined } as ConnectionOptions };
}

/** Whether a connection failed because the server's certificate could not be verified. */
export function isCertificateError(error: unknown): boolean {
  for (let current = error, depth = 0; typeof current === "object" && current !== null && depth < 5; depth += 1) {
    const code = "code" in current && typeof current.code === "string" ? current.code : null;
    if (code && certificateErrorCodes.has(code)) return true;
    const message = current instanceof Error ? current.message : "";
    if (/self[- ]signed certificate|unable to verify the first certificate|certificate has expired|Hostname\/IP does not match|no longer matches the trusted certificate/i.test(message)) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/** Reads the certificate a server presents, without trusting it and without sending credentials. */
export const inspectCertificate: InspectCertificate = async (endpoint) => {
  const connecting = endpoint.secure ? connectInsecure(endpoint) : startTlsInsecure(endpoint);
  // A handshake that finishes after the timeout must not leave its socket open.
  const socket = await withTimeout(connecting, 10_000).catch((error: unknown) => {
    void connecting.then((late) => late.destroy(), () => undefined);
    throw error;
  });
  try {
    const peer = socket.getPeerCertificate(false);
    if (!peer?.raw) throw new Error("The server presented no certificate");
    return presentedCertificate(endpoint, new X509Certificate(peer.raw));
  } finally {
    socket.destroy();
  }
};

export function presentedCertificate(endpoint: TlsEndpoint, certificate: X509Certificate): PresentedCertificate & { pem: string } {
  return {
    service: endpoint.protocol,
    host: endpoint.host,
    port: endpoint.port,
    fingerprint: normalizeFingerprint(certificate.fingerprint256),
    subject: certificate.subject.replace(/\n/g, ", "),
    issuer: certificate.issuer.replace(/\n/g, ", "),
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
    selfSigned: certificate.subject === certificate.issuer,
    pem: certificate.toString(),
  };
}

function tlsTarget(endpoint: TlsEndpoint): ConnectionOptions {
  // SNI must not carry an IP address.
  return isIP(endpoint.host) ? {} : { servername: endpoint.host };
}

function connectInsecure(endpoint: TlsEndpoint, socket?: Socket): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    // Inspection only: the certificate is shown to the owner and never trusted implicitly.
    const tlsSocket = connectTls({
      ...(socket ? { socket } : { host: endpoint.host, port: endpoint.port }),
      ...tlsTarget(endpoint),
      rejectUnauthorized: false,
    }, () => resolve(tlsSocket));
    tlsSocket.once("error", reject);
  });
}

async function startTlsInsecure(endpoint: TlsEndpoint): Promise<TLSSocket> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const plain = connectTcp({ host: endpoint.host, port: endpoint.port }, () => resolve(plain));
    plain.once("error", reject);
  });
  try {
    const lines = lineReader(socket);
    if (endpoint.protocol === "imap") {
      await lines.until((line) => /^\* (OK|PREAUTH)/i.test(line), (line) => /^\* BYE/i.test(line));
      socket.write("a1 STARTTLS\r\n");
      await lines.until((line) => /^a1 OK/i.test(line), (line) => /^a1 (NO|BAD)/i.test(line));
    } else {
      await lines.until((line) => /^220 /.test(line), (line) => /^[45]\d\d /.test(line));
      socket.write("EHLO postreeve.invalid\r\n");
      await lines.until((line) => /^250 /.test(line), (line) => /^[45]\d\d /.test(line));
      socket.write("STARTTLS\r\n");
      await lines.until((line) => /^220 /.test(line), (line) => /^[45]\d\d /.test(line));
    }
    lines.release();
    return await connectInsecure(endpoint, socket);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function lineReader(socket: Socket) {
  let buffer = "";
  let waiting: { done: (line: string) => boolean; failed: (line: string) => boolean; resolve: () => void; reject: (error: Error) => void } | null = null;
  const drain = () => {
    let newline = buffer.indexOf("\n");
    while (waiting && newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      const current = waiting;
      if (current.failed(line)) { waiting = null; current.reject(new Error(`The server refused STARTTLS: ${line.slice(0, 200)}`)); }
      else if (current.done(line)) { waiting = null; current.resolve(); }
      newline = buffer.indexOf("\n");
    }
  };
  const onData = (chunk: Buffer) => { buffer += chunk.toString("latin1"); drain(); };
  const onClose = () => waiting?.reject(new Error("The server closed the connection before STARTTLS"));
  socket.on("data", onData);
  socket.once("close", onClose);
  return {
    until(done: (line: string) => boolean, failed: (line: string) => boolean): Promise<void> {
      return new Promise((resolve, reject) => { waiting = { done, failed, resolve, reject }; drain(); });
    },
    release() {
      socket.off("data", onData);
      socket.off("close", onClose);
    },
  };
}

async function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out reading the server certificate")), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
