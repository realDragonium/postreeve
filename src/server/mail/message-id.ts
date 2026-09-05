const atextPattern = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]$/;

class Cursor {
  index = 0;

  constructor(readonly value: string) {}

  consumeFws(): string | null {
    const start = this.index;
    let unfolded = "";
    while (isWsp(this.value[this.index])) unfolded += this.value[this.index++];
    const mayRepeatFold = this.index > start;
    if (this.value.startsWith("\r\n", this.index) && isWsp(this.value[this.index + 2])) {
      this.index += 2;
      while (isWsp(this.value[this.index])) unfolded += this.value[this.index++];
      if (mayRepeatFold) {
        while (this.value.startsWith("\r\n", this.index) && isWsp(this.value[this.index + 2])) {
          this.index += 2;
          while (isWsp(this.value[this.index])) unfolded += this.value[this.index++];
        }
      }
    }
    return this.index === start ? null : unfolded;
  }

  consumeComment(): boolean {
    const start = this.index;
    if (this.value[this.index] !== "(") return false;
    this.index += 1;
    let depth = 1;
    while (this.index < this.value.length) {
      this.consumeFws();
      const character = this.value[this.index];
      if (character === ")") {
        this.index += 1;
        depth -= 1;
        if (depth === 0) return true;
        continue;
      }
      if (character === "(") {
        this.index += 1;
        depth += 1;
        continue;
      }
      if (character === "\\") {
        if (!this.consumeQuotedPair()) break;
        continue;
      }
      if (character !== undefined && isCommentText(character)) {
        this.index += 1;
        continue;
      }
      break;
    }
    this.index = start;
    return false;
  }

  consumeCfws(): void {
    while (true) {
      const start = this.index;
      this.consumeFws();
      if (this.value[this.index] === "(" && !this.consumeComment()) {
        this.index = start;
        return;
      }
      if (this.index === start) return;
    }
  }

  consumeAtom(): string | null {
    const start = this.index;
    this.consumeCfws();
    const atomStart = this.index;
    while (this.value[this.index] !== undefined && atextPattern.test(this.value[this.index]!)) this.index += 1;
    if (this.index === atomStart) {
      this.index = start;
      return null;
    }
    const atom = this.value.slice(atomStart, this.index);
    this.consumeCfws();
    return atom;
  }

  consumeQuotedString(): string | null {
    const start = this.index;
    this.consumeCfws();
    if (this.value[this.index] !== '"') {
      this.index = start;
      return null;
    }
    let content = "";
    this.index += 1;
    while (this.index < this.value.length) {
      const fws = this.consumeFws();
      if (fws !== null) content += fws;
      const character = this.value[this.index];
      if (character === '"') {
        this.index += 1;
        this.consumeCfws();
        return content;
      }
      if (character === "\\") {
        const escaped = this.consumeQuotedPair();
        if (escaped === null) break;
        content += escaped;
        continue;
      }
      if (character !== undefined && isQuotedText(character)) {
        content += character;
        this.index += 1;
        continue;
      }
      break;
    }
    this.index = start;
    return null;
  }

  consumeDomainLiteral(): string | null {
    const start = this.index;
    this.consumeCfws();
    if (this.value[this.index] !== "[") {
      this.index = start;
      return null;
    }
    let content = "";
    this.index += 1;
    while (this.index < this.value.length) {
      const fws = this.consumeFws();
      if (fws !== null) content += fws;
      const character = this.value[this.index];
      if (character === "]") {
        this.index += 1;
        this.consumeCfws();
        return content;
      }
      if (character === "\\") {
        const escaped = this.consumeQuotedPair();
        if (escaped === null) break;
        content += escaped;
        continue;
      }
      if (character !== undefined && isDomainText(character)) {
        content += character;
        this.index += 1;
        continue;
      }
      break;
    }
    this.index = start;
    return null;
  }

  private consumeQuotedPair(): string | null {
    const escaped = this.value[this.index + 1];
    if (this.value[this.index] !== "\\" || escaped === undefined || escaped.charCodeAt(0) > 127) return null;
    this.index += 2;
    return escaped;
  }
}

function isWsp(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function isCommentText(character: string): boolean {
  const code = character.charCodeAt(0);
  return isObsNoWsControl(code)
    || (code >= 33 && code <= 39)
    || (code >= 42 && code <= 91)
    || (code >= 93 && code <= 126);
}

function isQuotedText(character: string): boolean {
  const code = character.charCodeAt(0);
  return isObsNoWsControl(code) || code === 33 || (code >= 35 && code <= 91) || (code >= 93 && code <= 126);
}

function isDomainText(character: string): boolean {
  const code = character.charCodeAt(0);
  return isObsNoWsControl(code) || (code >= 33 && code <= 90) || (code >= 94 && code <= 126);
}

function isObsNoWsControl(code: number): boolean {
  return (code >= 1 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
}

function consumeWord(cursor: Cursor): string | null {
  return cursor.consumeQuotedString() ?? cursor.consumeAtom();
}

function consumeWordSequence(cursor: Cursor): string | null {
  const start = cursor.index;
  const first = consumeWord(cursor);
  if (first === null) return null;
  const words = [first];
  while (cursor.value[cursor.index] === ".") {
    cursor.index += 1;
    const word = consumeWord(cursor);
    if (word === null) {
      cursor.index = start;
      return null;
    }
    words.push(word);
  }
  return serializeLocalPart(words.join("."));
}

function consumeAtomSequence(cursor: Cursor): string | null {
  const start = cursor.index;
  const first = cursor.consumeAtom();
  if (first === null) return null;
  const atoms = [first];
  while (cursor.value[cursor.index] === ".") {
    cursor.index += 1;
    const atom = cursor.consumeAtom();
    if (atom === null) {
      cursor.index = start;
      return null;
    }
    atoms.push(atom);
  }
  return atoms.join(".");
}

function serializeLocalPart(content: string): string {
  if (content.split(".").every((part) => part.length > 0 && [...part].every((character) => atextPattern.test(character)))) {
    return content;
  }
  return `"${[...content].map((character) => isQuotedText(character) || isWsp(character)
    ? character
    : `\\${character}`).join("")}"`;
}

function serializeDomainLiteral(content: string): string {
  return `[${[...content.toLowerCase()].map((character) =>
    (isDomainText(character) && !isObsNoWsControl(character.charCodeAt(0))) || isWsp(character)
      ? character
      : `\\${character}`).join("")}]`;
}

function parseMessageId(cursor: Cursor): string | null {
  const start = cursor.index;
  cursor.consumeCfws();
  if (cursor.value[cursor.index] !== "<") {
    cursor.index = start;
    return null;
  }
  cursor.index += 1;
  const left = consumeWordSequence(cursor);
  if (left === null || cursor.value[cursor.index] !== "@") {
    cursor.index = start;
    return null;
  }
  cursor.index += 1;
  const literal = cursor.consumeDomainLiteral();
  const right = literal === null ? consumeAtomSequence(cursor) : serializeDomainLiteral(literal);
  if (right === null || cursor.value[cursor.index] !== ">") {
    cursor.index = start;
    return null;
  }
  cursor.index += 1;
  cursor.consumeCfws();
  return `<${left}@${right.toLowerCase()}>`;
}

function parseMessageIds(value: string | null | undefined): string[] | null {
  if (value === null || value === undefined || value.length === 0) return [];
  const cursor = new Cursor(value);
  const result: string[] = [];
  while (cursor.index < value.length) {
    const parsed = parseMessageId(cursor);
    if (parsed === null) return null;
    result.push(parsed);
  }
  return result;
}

function parseThreadingMessageIds(value: string | null | undefined): string[] | null {
  if (value === null || value === undefined || value.length === 0) return [];
  const cursor = new Cursor(value);
  const result: string[] = [];
  let phraseHasWord = false;
  while (cursor.index < value.length) {
    cursor.consumeCfws();
    if (cursor.index === value.length) break;
    if (cursor.value[cursor.index] === "<") {
      const parsed = parseMessageId(cursor);
      if (parsed === null) return null;
      result.push(parsed);
      phraseHasWord = false;
      continue;
    }
    const word = consumeWord(cursor);
    if (word !== null) {
      phraseHasWord = true;
      continue;
    }
    if (cursor.value[cursor.index] === "." && phraseHasWord) {
      cursor.index += 1;
      continue;
    }
    return null;
  }
  return result;
}

export interface IdentificationFieldValues {
  messageId: readonly string[];
  inReplyTo: readonly string[];
  references: readonly string[];
}

export interface NormalizedIdentificationFields {
  messageId: string | null;
  messageIdPresent: boolean;
  inReplyTo: string | null;
  references: string[];
}

export function normalizeIdentificationFields(values: IdentificationFieldValues): NormalizedIdentificationFields {
  const messageIds = values.messageId.flatMap((value) => parseMessageIds(value) ?? []);
  const messageId = values.messageId.length === 1 && messageIds.length === 1 ? messageIds[0] ?? null : null;
  const validInReplyTo = values.inReplyTo.filter((value) => (parseThreadingMessageIds(value)?.length ?? 0) > 0);
  return {
    messageId,
    messageIdPresent: values.messageId.length > 0,
    inReplyTo: validInReplyTo.length > 0 ? validInReplyTo.join(" ") : null,
    references: normalizeMessageIdLists(values.references),
  };
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  const messageIds = parseMessageIds(value);
  return messageIds?.length === 1 ? messageIds[0] ?? null : null;
}

export function normalizeMessageIdList(value: string | null | undefined): string[] {
  return [...new Set(parseThreadingMessageIds(value) ?? [])];
}

export function normalizeMessageIdLists(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.flatMap(normalizeMessageIdList))];
}
