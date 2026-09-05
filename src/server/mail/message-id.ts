const dotAtom = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const quotedLocal = '"(?:[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])*"';
const domainLiteral = "\\[(?:[\\x21-\\x5a\\x5e-\\x7e]|\\\\[\\x20-\\x7e])*\\]";
const messageIdPattern = new RegExp(`^<(${dotAtom}|${quotedLocal})@(${dotAtom}|${domainLiteral})>$`);

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

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const messageIdStart = consumeCfws(value, 0);
  for (let messageIdEnd = messageIdStart; messageIdEnd < value.length; messageIdEnd += 1) {
    if (value[messageIdEnd] !== ">") continue;
    const match = messageIdPattern.exec(value.slice(messageIdStart, messageIdEnd + 1));
    if (!match || consumeCfws(value, messageIdEnd + 1) !== value.length) continue;
    return `<${match[1]}@${match[2]!.toLowerCase()}>`;
  }
  return null;
}
