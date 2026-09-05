import { normalizeMessageIdList } from "./message-id";

export interface ThreadingMetadata {
  inReplyTo: string | null;
  references: readonly string[];
  referenceSequences?: readonly (readonly string[])[];
}

export interface ConversationMessageForOrder extends ThreadingMetadata {
  id: string;
  identityKey: string;
  messageId: string | null;
  receivedAt: string | null;
  threadingEdges?: readonly string[];
}

export function mergeThreadingMetadata(
  observedInReplyTo: string | null,
  observedReferences: readonly string[],
  retained: ThreadingMetadata,
  merged: readonly ThreadingMetadata[],
  observedReferenceSequences: readonly (readonly string[])[] = [observedReferences],
): { inReplyTo: string | null; references: string[]; edges: string[]; referenceSequences: string[][] } {
  const rows = [retained, ...merged];
  const parents = [...new Set([observedInReplyTo, ...rows.map(({ inReplyTo }) => inReplyTo)]
    .flatMap(normalizeMessageIdList))].sort();
  const referenceSequences = [...rows.map(({ references }) => references), observedReferences];
  const retainedSequences = rows.flatMap((metadata) =>
    metadata.referenceSequences ?? [[...metadata.references]]);
  const evidenceByKey = new Map([...retainedSequences, ...observedReferenceSequences]
    .map((sequence) => [...new Set(sequence)])
    .filter((sequence) => sequence.length > 0)
    .map((sequence) => [JSON.stringify(sequence), sequence] as const));
  const evidence = [...evidenceByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, sequence]) => sequence);
  const references = mergeReferenceSequences(referenceSequences, evidence);
  return {
    inReplyTo: parents.length > 0 ? parents.join(" ") : null,
    references,
    edges: [...new Set([...parents, ...references])].sort(),
    referenceSequences: evidence,
  };
}

function mergeReferenceSequences(
  sequences: readonly (readonly string[])[],
  evidence: readonly (readonly string[])[],
): string[] {
  const uniqueSequences = sequences.map((sequence) => [...new Set(sequence)]);
  const values = [...new Set(uniqueSequences.flat())];
  const after = new Map(values.map((value) => [value, new Set<string>()]));
  for (const sequence of evidence) {
    for (let index = 1; index < sequence.length; index += 1) {
      const before = sequence[index - 1]!;
      const later = sequence[index]!;
      if (after.has(before) && after.has(later)) after.get(before)!.add(later);
    }
  }
  return orderDirectedGraph(values, after, (left, right) => left.localeCompare(right));
}

export function orderConversationMessages<T extends ConversationMessageForOrder>(messages: readonly T[]): T[] {
  type OrderNode =
    | { kind: "message"; message: T }
    | { kind: "reference"; messageId: string };
  const messageNodes = new Map(messages.map((message) => [message.id, {
    kind: "message" as const,
    message,
  }]));
  const byMessageId = new Map(messages.flatMap((message) => {
    const node = messageNodes.get(message.id)!;
    return message.messageId ? [[message.messageId, node] as const] : [];
  }));
  const referenceNodes = new Map<string, OrderNode>();
  const children = new Map<OrderNode, Set<OrderNode>>(
    [...messageNodes.values()].map((node) => [node, new Set<OrderNode>()]),
  );
  const nodeForReference = (messageId: string): OrderNode => {
    const messageNode = byMessageId.get(messageId);
    if (messageNode) return messageNode;
    const retained = referenceNodes.get(messageId);
    if (retained) return retained;
    const created: OrderNode = { kind: "reference", messageId };
    referenceNodes.set(messageId, created);
    children.set(created, new Set());
    return created;
  };
  for (const message of messages) {
    const messageNode = messageNodes.get(message.id)!;
    for (const parent of normalizeMessageIdList(message.inReplyTo)) {
      const parentNode = nodeForReference(parent);
      if (parentNode !== messageNode) children.get(parentNode)!.add(messageNode);
    }

    if (message.referenceSequences) {
      for (const sequence of message.referenceSequences) {
        let previousAncestor: OrderNode | null = null;
        for (const reference of new Set(sequence)) {
          const ancestor = nodeForReference(reference);
          if (ancestor === messageNode) continue;
          if (previousAncestor) children.get(previousAncestor)!.add(ancestor);
          previousAncestor = ancestor;
        }
        if (previousAncestor) children.get(previousAncestor)!.add(messageNode);
      }
    } else {
      let previousAncestor: OrderNode | null = null;
      for (const reference of new Set(message.references)) {
        const ancestor = nodeForReference(reference);
        if (ancestor === messageNode) continue;
        if (previousAncestor) children.get(previousAncestor)!.add(ancestor);
        previousAncestor = ancestor;
      }
      if (previousAncestor) children.get(previousAncestor)!.add(messageNode);
    }

    for (const parent of new Set(message.threadingEdges ?? [])) {
      const parentNode = nodeForReference(parent);
      if (parentNode !== messageNode) children.get(parentNode)!.add(messageNode);
    }
  }

  const compareMessages = (left: T, right: T): number => {
    if (left.receivedAt === null && right.receivedAt !== null) return 1;
    if (left.receivedAt !== null && right.receivedAt === null) return -1;
    return (left.receivedAt?.localeCompare(right.receivedAt ?? "") ?? 0)
      || left.identityKey.localeCompare(right.identityKey);
  };
  const compareNodes = (left: OrderNode, right: OrderNode): number => {
    if (left.kind === "message" && right.kind === "message") return compareMessages(left.message, right.message);
    if (left.kind === "reference" && right.kind === "reference") return left.messageId.localeCompare(right.messageId);
    return left.kind === "reference" ? -1 : 1;
  };
  return orderDirectedGraph([...children.keys()], children, compareNodes, (node) => node.kind === "message")
    .flatMap((node) => node.kind === "message" ? [node.message] : []);
}

function orderDirectedGraph<T>(
  values: readonly T[],
  after: ReadonlyMap<T, ReadonlySet<T>>,
  compareValues: (left: T, right: T) => number,
  isVisible: (value: T) => boolean = () => true,
): T[] {
  const indexByValue = new Map<T, number>();
  const lowByValue = new Map<T, number>();
  const stack: T[] = [];
  const stacked = new Set<T>();
  const components: T[][] = [];
  let nextIndex = 0;
  interface VisitFrame {
    value: T;
    laterValues: T[];
    nextLater: number;
  }
  const startVisit = (value: T): VisitFrame => {
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
        const component: T[] = [];
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

  const componentByValue = new Map<T, number>();
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

  const representatives = components.map((component) => {
    const visibleIndex = component.findIndex(isVisible);
    return visibleIndex === -1
      ? { visible: false as const, value: component[0]! }
      : { visible: true as const, value: component[visibleIndex]! };
  });
  interface ReadyEntry {
    component: number;
    sequence: number;
  }
  const compareReady = (left: ReadyEntry, right: ReadyEntry): number => {
    const leftRepresentative = representatives[left.component]!;
    const rightRepresentative = representatives[right.component]!;
    if (leftRepresentative.visible !== rightRepresentative.visible) return leftRepresentative.visible ? 1 : -1;
    return compareValues(leftRepresentative.value, rightRepresentative.value) || left.sequence - right.sequence;
  };
  const ready = new MinPriorityQueue(compareReady);
  let nextSequence = 0;
  for (let component = 0; component < components.length; component += 1) {
    if (incoming.get(component) === 0) ready.push({ component, sequence: nextSequence++ });
  }
  const ordered: T[] = [];
  while (ready.size > 0) {
    const component = ready.pop()!.component;
    ordered.push(...components[component]!.filter(isVisible));
    for (const later of componentAfter.get(component)!) {
      const remaining = incoming.get(later)! - 1;
      incoming.set(later, remaining);
      if (remaining === 0) {
        ready.push({ component: later, sequence: nextSequence++ });
      }
    }
  }
  return ordered;
}

class MinPriorityQueue<T> {
  readonly #compare: (left: T, right: T) => number;
  readonly #values: T[] = [];

  constructor(compare: (left: T, right: T) => number) {
    this.#compare = compare;
  }

  get size(): number {
    return this.#values.length;
  }

  push(value: T): void {
    let index = this.#values.length;
    this.#values.push(value);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentValue = this.#values[parent]!;
      if (this.#compare(parentValue, value) <= 0) break;
      this.#values[index] = parentValue;
      index = parent;
    }
    this.#values[index] = value;
  }

  pop(): T | undefined {
    const first = this.#values[0];
    const last = this.#values.pop();
    if (first === undefined || last === undefined || this.#values.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.#values.length) break;
      const right = left + 1;
      const child = right < this.#values.length
        && this.#compare(this.#values[right]!, this.#values[left]!) < 0 ? right : left;
      if (this.#compare(last, this.#values[child]!) <= 0) break;
      this.#values[index] = this.#values[child]!;
      index = child;
    }
    this.#values[index] = last;
    return first;
  }
}
