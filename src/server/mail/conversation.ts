import { normalizeMessageIdList } from "./message-id";

export interface ThreadingMetadata {
  inReplyTo: string | null;
  references: readonly string[];
}

export interface ConversationMessageForOrder extends ThreadingMetadata {
  id: string;
  identityKey: string;
  messageId: string | null;
  receivedAt: string | null;
}

export function mergeThreadingMetadata(
  observedInReplyTo: string | null,
  observedReferences: readonly string[],
  retained: ThreadingMetadata,
  merged: readonly ThreadingMetadata[],
): { inReplyTo: string | null; references: string[]; edges: string[] } {
  const rows = [retained, ...merged];
  const parents = [...new Set([observedInReplyTo, ...rows.map(({ inReplyTo }) => inReplyTo)]
    .flatMap(normalizeMessageIdList))].sort();
  const references = mergeReferenceSequences([...rows.map(({ references }) => references), observedReferences]);
  return {
    inReplyTo: parents.length > 0 ? parents.join(" ") : null,
    references,
    edges: [...new Set([...parents, ...references])].sort(),
  };
}

function mergeReferenceSequences(sequences: readonly (readonly string[])[]): string[] {
  const values = [...new Set(sequences.flat())];
  const after = new Map(values.map((value) => [value, new Set<string>()]));
  const incoming = new Map(values.map((value) => [value, 0]));
  for (const sequence of sequences) {
    for (let index = 0; index < sequence.length; index += 1) {
      for (const later of sequence.slice(index + 1)) {
        const earlier = sequence[index]!;
        if (earlier === later || after.get(earlier)!.has(later)) continue;
        after.get(earlier)!.add(later);
        incoming.set(later, incoming.get(later)! + 1);
      }
    }
  }
  const ready = values.filter((value) => incoming.get(value) === 0).sort();
  const result: string[] = [];
  while (ready.length > 0) {
    const value = ready.shift()!;
    result.push(value);
    for (const later of [...after.get(value)!].sort()) {
      const remaining = incoming.get(later)! - 1;
      incoming.set(later, remaining);
      if (remaining === 0) {
        ready.push(later);
        ready.sort();
      }
    }
  }
  const included = new Set(result);
  return [...result, ...values.filter((value) => !included.has(value)).sort()];
}

export function orderConversationMessages<T extends ConversationMessageForOrder>(messages: readonly T[]): T[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const byMessageId = new Map(messages.flatMap((message) =>
    message.messageId ? [[message.messageId, message.id] as const] : []));
  const children = new Map(messages.map(({ id }) => [id, new Set<string>()]));
  for (const message of messages) {
    for (const reference of new Set([...normalizeMessageIdList(message.inReplyTo), ...message.references])) {
      if (!reference) continue;
      const parentId = byMessageId.get(reference);
      if (parentId && parentId !== message.id) children.get(parentId)!.add(message.id);
    }
  }

  const indexById = new Map<string, number>();
  const lowById = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;
  const visit = (id: string): void => {
    indexById.set(id, nextIndex);
    lowById.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    stacked.add(id);
    for (const childId of children.get(id)!) {
      if (!indexById.has(childId)) {
        visit(childId);
        lowById.set(id, Math.min(lowById.get(id)!, lowById.get(childId)!));
      } else if (stacked.has(childId)) {
        lowById.set(id, Math.min(lowById.get(id)!, indexById.get(childId)!));
      }
    }
    if (lowById.get(id) !== indexById.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      stacked.delete(member);
      component.push(member);
      if (member === id) break;
    }
    components.push(component);
  };
  for (const { id } of messages) if (!indexById.has(id)) visit(id);

  const componentByMessage = new Map<string, number>();
  components.forEach((component, index) => {
    for (const id of component) componentByMessage.set(id, index);
  });
  const componentChildren = new Map(components.map((_, index) => [index, new Set<number>()]));
  const incoming = new Map(components.map((_, index) => [index, 0]));
  for (const [parentId, childIds] of children) {
    const parentComponent = componentByMessage.get(parentId)!;
    for (const childId of childIds) {
      const childComponent = componentByMessage.get(childId)!;
      if (parentComponent === childComponent || componentChildren.get(parentComponent)!.has(childComponent)) continue;
      componentChildren.get(parentComponent)!.add(childComponent);
      incoming.set(childComponent, incoming.get(childComponent)! + 1);
    }
  }

  const compareMessages = (leftId: string, rightId: string): number => {
    const left = byId.get(leftId)!;
    const right = byId.get(rightId)!;
    if (left.receivedAt === null && right.receivedAt !== null) return 1;
    if (left.receivedAt !== null && right.receivedAt === null) return -1;
    return (left.receivedAt?.localeCompare(right.receivedAt ?? "") ?? 0)
      || left.identityKey.localeCompare(right.identityKey);
  };
  const sortedComponents = components.map((component) => component.sort(compareMessages));
  const compareComponents = (left: number, right: number): number =>
    compareMessages(sortedComponents[left]![0]!, sortedComponents[right]![0]!);
  const ready = components.map((_, index) => index).filter((index) => incoming.get(index) === 0).sort(compareComponents);
  const ordered: T[] = [];
  while (ready.length > 0) {
    const component = ready.shift()!;
    ordered.push(...sortedComponents[component]!.map((id) => byId.get(id)!));
    for (const child of componentChildren.get(component)!) {
      const remaining = incoming.get(child)! - 1;
      incoming.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort(compareComponents);
      }
    }
  }
  return ordered;
}
