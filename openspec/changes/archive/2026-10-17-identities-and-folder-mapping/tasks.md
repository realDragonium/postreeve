# Tasks

## 1. Special folders

- [x] 1.1 `src/shared/special-folders.ts`: roles, name lists, `specialUseFromName`, `resolveSpecialUses` with precedence tests
- [x] 1.2 `folderSchema.specialUseSource`, folder-mapping contracts
- [x] 1.3 `folder_mappings` table and migration (`src/server/db/folder-mappings.ts`), store wrappers, delete with account
- [x] 1.4 IMAP provider: `setFolderOverrides`, resolved `listFolders`, Sent/Drafts/Trash lookups and protection
- [x] 1.5 Service and API `GET`/`PUT /api/accounts/<id>/folder-mappings`; push overrides on registration
- [x] 1.6 Manage folders sheet: Special folders editor (IMAP), source labels

## 2. Wildcard identities

- [x] 2.1 Contracts: identity address accepts `*@domain`
- [x] 2.2 `identityFor`, `isOwnAddress`, `defaultFromAddress`, `signatureFor` in `src/shared/identities.ts` with tests
- [x] 2.3 Service: refuse wildcard on Gmail, `#draftSender` and signatures use the resolver
- [x] 2.4 Correspondents own-address test understands wildcards
- [x] 2.5 Compose: From options include the covered address, wildcard signature, Add as identity

## 3. Gmail Send mail as import

- [x] 3.1 `GmailMailClient.listSendAsIdentities`, optional provider method
- [x] 3.2 Service `importSendAsIdentities`, API route, best-effort import on connect
- [x] 3.3 Identity sheet Import from Gmail button

## 4. Docs and verification

- [x] 4.1 FEATURES.md rows
- [x] 4.2 `bun run verify`, `bunx openspec validate --specs --strict`
