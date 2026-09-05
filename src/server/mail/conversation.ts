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
  const uniqueSequences = sequences.map((sequence) => [...new Set(sequence)]);
  const values = [...new Set(uniqueSequences.flat())];
  const after = new Map(values.map((value) => [value, new Set<string>()]));
  for (const sequence of uniqueSequences) {
    for (let index = 1; index < sequence.length; index += 1) {
      after.get(sequence[index - 1]!)!.add(sequence[index]!);
    }
  }
  return orderDirectedGraph(values, after, (left, right) => left.localeCompare(right));
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

  const compareMessages = (leftId: string, rightId: string): number => {
    const left = byId.get(leftId)!;
    const right = byId.get(rightId)!;
    if (left.receivedAt === null && right.receivedAt !== null) return 1;
    if (left.receivedAt !== null && right.receivedAt === null) return -1;
    return (left.receivedAt?.localeCompare(right.receivedAt ?? "") ?? 0)
      || left.identityKey.localeCompare(right.identityKey);
  };
  return orderDirectedGraph([...byId.keys()], children, compareMessages).map((id) => byId.get(id)!);
}

function orderDirectedGraph(
  values: readonly string[],
  after: ReadonlyMap<string, ReadonlySet<string>>,
  compareValues: (left: string, right: string) => number,
): string[] {
  const indexByValue = new Map<string, number>();
  const lowByValue = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;
  interface VisitFrame {
    value: string;
    laterValues: string[];
    nextLater: number;
  }
  const startVisit = (value: string): VisitFrame => {
    indexByValue.set(value, nextIndex);
    lowByValue.set(value, nextIndex);
    nextIndex += 1;
    stack.push(value);
    stacked.add(value);
    return { value, laterValues: [...(after.get(value) ?? [])], nextLater: 0 };
  };
  for (const value of values) {
    if (indexByValue.has(value)) continue;
    const visits = [startVisit(value)];
    while (visits.length > 0) {
      const visit = visits[visits.length - 1]!;
      const later = visit.laterValues[visit.nextLater];
      if (later !== undefined) {
        visit.nextLater += 1;
        if (!indexByValue.has(later)) {
          visits.push(startVisit(later));
        } else if (stacked.has(later)) {
          lowByValue.set(visit.value, Math.min(lowByValue.get(visit.value)!, indexByValue.get(later)!));
        }
        continue;
      }

      visits.pop();
      const parent = visits[visits.length - 1];
      if (parent) {
        lowByValue.set(parent.value, Math.min(lowByValue.get(parent.value)!, lowByValue.get(visit.value)!));
      }
      if (lowByValue.get(visit.value) === indexByValue.get(visit.value)) {
        const component: string[] = [];
        while (stack.length > 0) {
          const member = stack.pop()!;
          stacked.delete(member);
          component.push(member);
          if (member === visit.value) break;
        }
        components.push(component.sort(compareValues));
      }
    }
  }

  const componentByValue = new Map<string, number>();
  components.forEach((component, index) => {
    for (const value of component) componentByValue.set(value, index);
  });
  const componentAfter = new Map(components.map((_, index) => [index, new Set<number>()]));
  const incoming = new Map(components.map((_, index) => [index, 0]));
  for (const [value, laterValues] of after) {
    const component = componentByValue.get(value)!;
    for (const later of laterValues) {
      const laterComponent = componentByValue.get(later)!;
      if (component === laterComponent || componentAfter.get(component)!.has(laterComponent)) continue;
      componentAfter.get(component)!.add(laterComponent);
      incoming.set(laterComponent, incoming.get(laterComponent)! + 1);
    }
  }

  const compareComponents = (left: number, right: number): number =>
    compareValues(components[left]![0]!, components[right]![0]!);
  const ready = components.map((_, index) => index)
    .filter((index) => incoming.get(index) === 0)
    .sort(compareComponents);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const component = ready.shift()!;
    ordered.push(...components[component]!);
    for (const later of componentAfter.get(component)!) {
      const remaining = incoming.get(later)! - 1;
      incoming.set(later, remaining);
      if (remaining === 0) {
        ready.push(later);
        ready.sort(compareComponents);
      }
    }
  }
  return ordered;
}
