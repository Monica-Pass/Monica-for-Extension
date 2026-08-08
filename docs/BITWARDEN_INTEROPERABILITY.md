# Bitwarden and Vaultwarden interoperability acceptance

`npm run test:bitwarden-interop` executes two deterministic server-contract profiles without live account credentials.

The official Bitwarden profile records PascalCase synchronization fields, `Profile.Organizations`, complete Cipher mutation responses, Azure attachment upload, and HTTP 204 attachment deletion. The Vaultwarden profile records camelCase synchronization fields, wrapped `OrganizationsNew`, reduced update and Collection acknowledgements, Direct multipart attachment upload, and JSON deletion responses.

Each profile verifies the following exchange:

1. Prelogin and password login unwrap the user vault key.
2. Personal and organization Ciphers decrypt from the synchronization response.
3. A personal Cipher is created, then a login edit and Passkey counter update share one parent Cipher write.
4. Password history, unknown fields, encrypted Passkey data, organization ownership, and Collection metadata survive the write.
5. An organization Cipher moves between writable Collections while reduced responses retain the complete encrypted projection.
6. An attachment is created with an independent key, uploaded through the profile-specific transport, downloaded and authenticated before plaintext use, then deleted.
7. Signed object requests carry no Bitwarden Bearer authorization.
8. An authenticated empty vault preserves the local baseline until an explicit confirmation adopts the empty result.

The committed profiles exercise reviewed wire contracts and remain repeatable in CI. Live production-account checks remain an external release acceptance because they require disposable official Bitwarden and Vaultwarden accounts, organization membership, storage quota, and credentials that must never enter repository fixtures or logs.
