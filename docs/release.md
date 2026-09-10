# Releasing Zebu Desktop

Releases are built by GitHub Actions (`.github/workflows/release.yml`) with
[tauri-action](https://github.com/tauri-apps/tauri-action): pushing a tag
`vX.Y.Z` produces a **draft GitHub Release** carrying the macOS, Windows and
Linux installers, their signatures, and the updater manifest `latest.json`
that installed copies poll. Publishing the draft makes it the *latest*
release — the one the downloads page links to and the in-app updater installs.

## One-time setup

### 1. Repository

Create the GitHub repository (the placeholders assume `OWNER/zebu-desktop`)
and replace `OWNER` in:

- `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`
- `zebu-public/downloads.html` → every `github.com/OWNER/zebu-desktop` link

### 2. Updater keypair (required)

Updates are signed with a [minisign](https://jedisct1.github.io/minisign/)
keypair; the app refuses any update whose signature does not verify against
the public key baked into `tauri.conf.json`.

```bash
npm run tauri signer generate -- -w ~/.tauri/zebu-desktop.key
```

Choose a password when prompted (you may leave it empty; then set the
password secret to an empty string). The command prints the public key and
writes the private key to `~/.tauri/zebu-desktop.key`.

- Paste the **public key** into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`
  (replacing `REPLACE_WITH_UPDATER_PUBLIC_KEY`) and commit it.
- Add the **private key file's contents** as the secret `TAURI_SIGNING_PRIVATE_KEY`
  and its password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Keep the private key backed up somewhere safe: **if it is lost, existing
installs can never update again** (they would have to reinstall from the
downloads page). Never commit it.

Local `npm run tauri build` also needs the key once `createUpdaterArtifacts`
is on: `export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/zebu-desktop.key)"`
(and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).

### 3. macOS signing and notarization (strongly recommended)

Unsigned apps are refused by Gatekeeper on macOS 11+ ("cannot be opened
because the developer cannot be verified"). You need a paid
[Apple Developer Program](https://developer.apple.com/programs/) membership
(US$99/year).

1. **Developer ID Application certificate.** In Xcode → Settings → Accounts →
   Manage Certificates → “+” → *Developer ID Application*, or on
   [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list)
   (create a CSR with Keychain Access → Certificate Assistant → Request a
   Certificate from a Certificate Authority). Install it in your login
   keychain.
2. **Export it as .p12.** Keychain Access → My Certificates → right-click the
   *Developer ID Application: Your Name (TEAMID)* entry → Export → .p12 with
   a password. Base64-encode it for the secret:
   ```bash
   base64 -i DeveloperID.p12 | pbcopy
   ```
3. **App-specific password** for notarization: sign in at
   [account.apple.com](https://account.apple.com/account/manage) → Sign-In
   and Security → App-Specific Passwords → “+”. This is *not* your Apple ID
   password.
4. **Team ID**: shown at the top right of
   [developer.apple.com/account](https://developer.apple.com/account) under
   Membership details (10 characters).

Secrets to add (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the exported `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the password you gave the `.p12` export |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` — `security find-identity -v -p codesigning` lists it |
| `APPLE_ID` | the Apple ID e-mail of the developer account |
| `APPLE_PASSWORD` | the app-specific password from step 3 |
| `APPLE_TEAM_ID` | the 10-character Team ID |

tauri-action imports the certificate into a temporary keychain, signs the
app with the hardened runtime (`src-tauri/Entitlements.plist` grants the
JIT exceptions WebKit needs), submits it to Apple's notary service, and
staples the ticket. Notarization typically takes 1–10 minutes. When these
secrets are absent the workflow still succeeds but prints a warning and
ships an unsigned `.dmg`.

### 4. Windows signing (optional, recommended)

Without a signature Windows shows a SmartScreen "unknown publisher" notice
on first launch and the user must click *More info → Run anyway*. Options:

| Option | Cost / effort | Notes |
| --- | --- | --- |
| **Azure Trusted Signing** (wired into the workflow) | ~US$10/month; needs an Azure subscription and an identity validation (business, or individual in supported countries) | No hardware token, works headless in CI, immediate SmartScreen reputation. Tauri's [documented](https://v2.tauri.app/distribute/sign/windows/#azure-code-signing) approach. |
| **OV / EV certificate** from a CA (DigiCert, Sectigo, SSL.com, …) | US$200–600/year; since 2023 the key must live on an HSM or USB token | Hard to use in GitHub-hosted CI: needs the CA's cloud signing service (e.g. SSL.com eSigner, DigiCert KeyLocker) or a self-hosted runner with the token. EV gives instant reputation; OV builds it over time. |
| **Unsigned** | free | SmartScreen warning on every download until enough installs build reputation; corporate policies may block it. Fine for a private beta. |

For Azure Trusted Signing: create a *Trusted Signing account* and a
*certificate profile* in the Azure portal, create an app registration
(service principal) with the *Trusted Signing Certificate Profile Signer*
role, and add these secrets — the workflow installs
[`trusted-signing-cli`](https://github.com/Levminer/trusted-signing-cli) and
passes it to Tauri as `bundle.windows.signCommand` only when they exist:

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | Directory (tenant) ID of the app registration |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | a client secret of the app registration |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | e.g. `https://weu.codesigning.azure.net` (region of the account) |
| `AZURE_CODE_SIGNING_NAME` | the Trusted Signing account name |
| `AZURE_CERT_PROFILE_NAME` | the certificate profile name |

If you go with a traditional certificate instead, follow Tauri's
[Windows signing guide](https://v2.tauri.app/distribute/sign/windows/):
import the `.pfx` on the runner in a step before tauri-action and set
`bundle.windows.certificateThumbprint` / `digestAlgorithm` /
`timestampUrl` via a `--config` overlay the same way the workflow does for
Azure.

### 5. Secrets checklist

| Secret | Required | Purpose |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | yes | signs updater artifacts (`.sig` files) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | yes (may be empty) | password of that key |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | for signed macOS builds | Developer ID signing |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | for notarized macOS builds | notary service |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_NAME`, `AZURE_CERT_PROFILE_NAME` | for signed Windows builds | Azure Trusted Signing |

`GITHUB_TOKEN` is provided automatically; the workflow requests
`contents: write` to create the release.

## Cutting a release

Use the script — it does the whole of the manual sequence below in one go:

```bash
scripts/release.sh              # 0.1.4 -> 0.1.5; --minor, --major or an explicit 0.3.0 override it
```

It refuses to start if the tree is dirty, the branch is not `main`, `main` is
behind or diverged from `origin/main`, the tag already exists locally or on
origin, or the target version is not newer than the current one; then it runs
`npm test`, `npm run lint` and `cargo test`, writes the version into all three
files, brings `package-lock.json` and `Cargo.lock` along, and makes one
commit, one tag and one push. `--dry-run` prints every step and every file
change without touching anything; `--skip-checks` skips the gate (loudly —
the workflow runs it anyway). `scripts/tests/release.test.sh` exercises all of
it against throwaway repositories.

It does **not** touch `zebu-public/downloads.html` — that lives in another
repository and is still step 2 below.

### By hand

1. Bump the version — it must be identical in three places:
   `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`
   (then `cd src-tauri && cargo generate-lockfile --offline` or run
   `cargo check` so `Cargo.lock` follows). The workflow's first job fails if
   the tag disagrees with `tauri.conf.json`/`package.json`.
2. Update the release history and the current version/asset names in
   `zebu-public/downloads.html` (see below).
3. Commit, tag and push:
   ```bash
   git commit -am "Release 0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```
4. Watch the *Release* workflow. Three jobs (macOS universal, Windows x64,
   Linux x86_64) attach to the same **draft** release; the last one to finish
   also uploads `latest.json`.
5. Open the draft on GitHub, check the assets and notes, and **Publish**.
   From that moment `…/releases/latest/download/<asset>` resolves to the new
   files and running apps offer the update on their next launch.

A `workflow_dispatch` run (Actions → Release → Run workflow) builds all
three platforms without creating a release and uploads the bundles as
workflow artifacts — use it to validate signing before tagging.

### Asset names

tauri-action names assets from `productName` (`Zebu`) and the version:

| Platform | Installer | Updater artifact |
| --- | --- | --- |
| macOS (universal) | `Zebu_0.2.0_universal.dmg` | `Zebu_universal.app.tar.gz` + `.sig` |
| Windows x64 | `Zebu_0.2.0_x64-setup.exe` (NSIS), `Zebu_0.2.0_x64_en-US.msi` | the same files + `.sig` |
| Linux x86_64 | `Zebu_0.2.0_amd64.AppImage`, `Zebu_0.2.0_amd64.deb`, `Zebu-0.2.0-1.x86_64.rpm` | `Zebu_0.2.0_amd64.AppImage` + `.sig` |
| all | `latest.json` | — |

`latest.json` lists one entry per updater target (`darwin-aarch64`,
`darwin-x86_64`, `windows-x86_64`, `linux-x86_64`) with the download URL
and signature; `updaterJsonPreferNsis` makes Windows installs update through
the NSIS installer rather than the MSI.

## How the downloads page picks up a release

`zebu-public/downloads.html` links to
`https://github.com/OWNER/zebu-desktop/releases/latest/download/<asset>`.
GitHub redirects `releases/latest/download/…` to the asset of that name on
the most recently **published, non-prerelease** release — so the page needs
no deployment step, but because the version is part of every asset name the
file names on the page must be bumped with each release (step 2 above). A
draft release is not "latest", which is what lets you inspect the build
before the links flip.

## Testing an update locally (0.1.0 → 0.2.0)

1. Generate a test keypair (or use the real one) and export
   `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` in your shell; put the matching
   public key in `tauri.conf.json`.
2. Point the updater at a local server: temporarily change
   `plugins.updater.endpoints` to `["http://localhost:8080/latest.json"]`
   and, because the updater refuses plain http by default, add
   `"dangerousInsecureTransportProtocol": true` next to it (dev only —
   never commit either change).
3. Build 0.1.0 (`npm run tauri build`) and install it — open the `.dmg`
   and drag the app to `/Applications` (on macOS the updater replaces the
   `.app` in place, so it must be installed, not run from `target/`).
4. Bump the version to 0.2.0 in `package.json`, `tauri.conf.json` and
   `Cargo.toml` and build again. Copy the updater artifact and its signature
   from `src-tauri/target/release/bundle/` (e.g. `macos/Zebu.app.tar.gz` and
   `Zebu.app.tar.gz.sig`) into a folder and write `latest.json` there:
   ```json
   {
     "version": "0.2.0",
     "notes": "Test update",
     "pub_date": "2026-09-05T12:00:00Z",
     "platforms": {
       "darwin-aarch64": { "signature": "<contents of Zebu.app.tar.gz.sig>", "url": "http://localhost:8080/Zebu.app.tar.gz" },
       "darwin-x86_64":  { "signature": "<same>", "url": "http://localhost:8080/Zebu.app.tar.gz" }
     }
   }
   ```
   (Windows: `nsis/Zebu_0.2.0_x64-setup.exe` + `.sig` under `windows-x86_64`;
   Linux: `appimage/Zebu_0.2.0_amd64.AppImage` + `.sig` under `linux-x86_64`.)
5. Serve the folder: `python3 -m http.server 8080`.
6. Launch the installed 0.1.0. About four seconds after launch it checks
   the endpoint and shows the "Zebu 0.2.0 is available" sheet; *Install &
   relaunch* downloads, verifies the signature, swaps the app and restarts
   it. Settings → the build line shows "Check for updates" / progress. After
   the relaunch the settings popout reads *Zebu Desktop v0.2.0*.

To test against the real pipeline instead, publish a `v0.2.0` release on
GitHub and launch an installed 0.1.0 whose `tauri.conf.json` already
carried the production endpoint and public key.
