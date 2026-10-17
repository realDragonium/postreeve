# Tasks

## 1. Special folders

- [ ] 1.1 `src/shared/special-folders.ts`: roles, name lists, `specialUseFromName`, `resolveSpecialUses` with precedence tests
- [ ] 1.2 `folderSchema.specialUseSource`, folder-mapping contracts
- [ ] 1.3 `folder_mappings` table and migration (`src/server/db/folder-mappings.ts`), store wrappers, delete with account
- [ ] 1.4 IMAP provider: `setFolderOverrides`, resolved `listFolders`, Sent/Drafts/Trash lookups and protection
- [ ] 1.5 Service and API `GET`/`PUT /api/accounts/<id>/folder-mappings`; push overrides on registration
- [ ] 1.6 Manage folders sheet: Special folders editor (IMAP), source labels

## 2. Wildcard identities

- [ ] 2.1 Contracts: identity address accepts `*@domain`
- [ ] 2.2 `identityFor`, `isOwnAddress`, `defaultFromAddress`, `signatureFor` in `src/shared/identities.ts` with tests
- [ ] 2.3 Service: refuse wildcard on Gmail, `#draftSender` and signatures use the resolver
- [ ] 2.4 Correspondents own-address test understands wildcards
- [ ] 2.5 Compose: From options include the covered address, wildcard signature, Add as identity

## 3. Gmail Send mail as import

- [ ] 3.1 `GmailMailClient.listSendAsIdentities`, optional provider method
- [ ] 3.2 Service `importSendAsIdentities`, API route, best-effort import on connect
- [ ] 3.3 Identity sheet Import from Gmail button

## 4. Docs and verification

- [ ] 4.1 FEATURES.md rows
- [ ] 4.2 `bun run verify`, `bunx openspec validate --specs --strict`
