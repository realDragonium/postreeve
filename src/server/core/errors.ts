import type { PresentedCertificate } from "../../shared/contracts";

export class DraftNotFoundError extends Error {
  constructor() {
    super("Draft not found");
    this.name = "DraftNotFoundError";
  }
}

export class DraftDeletedError extends Error {
  constructor() {
    super("Draft was deleted");
    this.name = "DraftDeletedError";
  }
}

export class DraftConflictError extends Error {
  constructor(message = "Draft version conflict") {
    super(message);
    this.name = "DraftConflictError";
  }
}

export class AccountConflictError extends Error {
  constructor(message = "Account has a draft delivery in progress") {
    super(message);
    this.name = "AccountConflictError";
  }
}

/** A connection failed because the server's certificate is not trusted; carries what the server presented. */
export class CertificateTrustError extends Error {
  constructor(message: string, readonly certificate: PresentedCertificate) {
    super(message);
    this.name = "CertificateTrustError";
  }
}
