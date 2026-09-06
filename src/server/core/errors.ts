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
