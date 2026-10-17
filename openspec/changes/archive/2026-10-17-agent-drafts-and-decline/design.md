# Design

## Decisions

- **Drafting is its own scope, granted with proposals.** Both prepare work the person finishes, so the middle tier ("Read and prepare") grants `mail:propose` and `mail:draft`. A separate scope still lets a future tier or PAT grant one without the other.
- **Identity by address, not ID.** `from` is an address; the tool fills the name from a matching identity or the account. It does not reject unknown addresses, so wildcard `*@domain` identities from feat/identities-folders work once merged; the send path already refuses an address that is not the account's.
- **Agents supply the whole body and subject.** Quoting and `Re:` prefixes are UI conveniences; an agent can include them. The mode and source still give the sent reply its threading headers.
- **`update_draft` merges onto the stored draft.** The draft API needs full content and a version; the tool reads the current draft and requires the agent's version, so concurrent human edits surface as a conflict instead of being overwritten.
- **Attachments as JSON text.** Tool results are JSON text on both surfaces; text-like types are decoded, others base64, capped at 5 MiB so a result stays a reasonable size.
- **Decline is human-only and final.** It mirrors approval: an agent that could decline could hide its own proposals. No `declinedAt` field; `updatedAt` records when.
- **Draft calls have no audit target.** The audit summary names the subject and mode; adding a `draft` target kind would change migration 900001's check constraint for little gain.
