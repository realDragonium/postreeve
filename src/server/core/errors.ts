export class DraftNotFoundError extends Error {
  constructor() {
    super("Draft not found");
    this.name = "DraftNotFoundError";
  }
}

export class DraftConflictError extends Error {
  constructor(message = "Draft version conflict") {
    super(message);
    this.name = "DraftConflictError";
  }
}
