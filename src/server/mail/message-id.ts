const dotAtom = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const quotedLocal = '"(?:[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])*"';
const domainLiteral = "\\[(?:[\\x21-\\x5a\\x5e-\\x7e]|\\\\[\\x20-\\x7e])*\\]";
const messageIdPattern = new RegExp(`^<(${dotAtom}|${quotedLocal})@(${dotAtom}|${domainLiteral})>$`);
const atextPattern = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]$/;

function isWsp(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function consumeFoldingWhitespace(value: string, start: number): number | null {
  let index = start;
  while (isWsp(value[index])) index += 1;
  if (value.startsWith("\r\n", index)) {
    index += 2;
    const whitespaceStart = index;
    while (isWsp(value[index])) index += 1;
    return index > whitespaceStart ? index : null;
  }
  return index > start ? index : null;
}

function consumeComment(value: string, start: number): number | null {
  let index = start + 1;
  let depth = 1;
  while (index < value.length) {
    const foldingWhitespaceEnd = consumeFoldingWhitespace(value, index);
    if (foldingWhitespaceEnd !== null) {
      index = foldingWhitespaceEnd;
      continue;
    }

    const character = value[index]!;
    if (character === ")") {
      depth -= 1;
      index += 1;
      if (depth === 0) return index;
      continue;
    }
    if (character === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === "\\") {
      const escaped = value[index + 1];
      if (escaped === undefined || !(isWsp(escaped) || (escaped >= "!" && escaped <= "~"))) return null;
      index += 2;
      continue;
    }
    const code = character.charCodeAt(0);
    if ((code >= 33 && code <= 39) || (code >= 42 && code <= 91) || (code >= 93 && code <= 126)) {
      index += 1;
      continue;
    }
    return null;
  }
  return null;
}

function consumeCfws(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const foldingWhitespaceEnd = consumeFoldingWhitespace(value, index);
    if (foldingWhitespaceEnd !== null) {
      index = foldingWhitespaceEnd;
      continue;
    }
    if (value[index] !== "(") break;
    const commentEnd = consumeComment(value, index);
    if (commentEnd === null) break;
    index = commentEnd;
  }
  return index;
}

function parseMessageIdAt(value: string, start: number): { id: string; end: number } | null {
  for (let end = start; end < value.length; end += 1) {
    if (value[end] !== ">") continue;
    const match = messageIdPattern.exec(value.slice(start, end + 1));
    if (match) return { id: `<${match[1]}@${match[2]!.toLowerCase()}>`, end: end + 1 };
  }
  return null;
}

function consumeQuotedString(value: string, start: number): number | null {
  let index = start + 1;
  while (index < value.length) {
    const foldingWhitespaceEnd = consumeFoldingWhitespace(value, index);
    if (foldingWhitespaceEnd !== null) {
      index = foldingWhitespaceEnd;
      continue;
    }
    const character = value[index]!;
    if (character === '"') return index + 1;
    if (character === "\\") {
      const escaped = value[index + 1];
      if (escaped === undefined || !(isWsp(escaped) || (escaped >= "!" && escaped <= "~"))) return null;
      index += 2;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code === 33 || (code >= 35 && code <= 91) || (code >= 93 && code <= 126)) {
      index += 1;
      continue;
    }
    return null;
  }
  return null;
}

function parseMessageIds(value: string | null | undefined): string[] | null {
  if (!value) return [];
  const result: string[] = [];
  let messageIdStart = consumeCfws(value, 0);
  while (messageIdStart < value.length) {
    const parsed = parseMessageIdAt(value, messageIdStart);
    if (!parsed) return null;
    result.push(parsed.id);
    messageIdStart = consumeCfws(value, parsed.end);
  }
  return result;
}

function parseThreadingMessageIds(value: string | null | undefined): string[] | null {
  if (!value) return [];
  const result: string[] = [];
  let index = 0;
  let phraseHasWord = false;
  while (index < value.length) {
    const cfwsEnd = consumeCfws(value, index);
    if (cfwsEnd > index) {
      index = cfwsEnd;
      continue;
    }
    const character = value[index]!;
    if (character === "<") {
      const parsed = parseMessageIdAt(value, index);
      if (!parsed) return null;
      result.push(parsed.id);
      index = parsed.end;
      phraseHasWord = false;
      continue;
    }
    if (character === '"') {
      const quotedEnd = consumeQuotedString(value, index);
      if (quotedEnd === null) return null;
      index = quotedEnd;
      phraseHasWord = true;
      continue;
    }
    if (atextPattern.test(character)) {
      do index += 1;
      while (index < value.length && atextPattern.test(value[index]!));
      phraseHasWord = true;
      continue;
    }
    if (character === "." && phraseHasWord) {
      index += 1;
      continue;
    }
    return null;
  }
  return result;
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
