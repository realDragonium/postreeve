const dotAtom = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const quotedLocal = '"(?:[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])*"';
const domainLiteral = "\\[(?:[\\x21-\\x5a\\x5e-\\x7e]|\\\\[\\x20-\\x7e])*\\]";
const messageIdPattern = new RegExp(`^<(${dotAtom}|${quotedLocal})@(${dotAtom}|${domainLiteral})>$`);

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = messageIdPattern.exec(value.trim());
  return match ? `<${match[1]}@${match[2]!.toLowerCase()}>` : null;
}
