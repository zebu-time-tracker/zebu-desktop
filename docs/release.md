# Releasing Zebu Desktop

Releases are built by GitHub Actions (`.github/workflows/release.yml`) with
[tauri-action](https://github.com/tauri-apps/tauri-action): pushing a tag
`vX.Y.Z` produces a **draft GitHub Release** carrying the macOS, Windows and
Linux installers and their signatures, and then publishes the same files to
the Cloudflare R2 bucket served at **https://app-downloads.zebu.work**, which
is where the in-app updater and the downloads page actually read from.

See [Where builds land](#where-builds-land) for the bucket layout and how to
roll a release back.

## One-time setup

### 1. Repository

Create the GitHub repository (the placeholders assume `OWNER/zebu-desktop`).
Nothing the app fetches lives on GitHub — see
[Where builds land](#where-builds-land) — so the only link to keep current is
`zebu-public/downloads.html`, which should point at
`https://app-downloads.zebu.work/desktop/latest/…`.

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

### 5. The download bucket (required)

Builds are served from a Cloudflare R2 bucket, `app-downloads`, with a public
custom domain of `app-downloads.zebu.work`. Create an R2 **API token** scoped
to that one bucket with *Object Read & Write*, and add three secrets:

| Secret | Value |
| --- | --- |
| `R2_ACCOUNT_ID` | the Cloudflare account id (the `<id>` in `https://<id>.r2.cloudflarestorage.com`) |
| `R2_ACCESS_KEY_ID` | the token's access key id |
| `R2_SECRET_ACCESS_KEY` | the token's secret access key |

The workflow talks to R2 through the S3-compatible API with a pinned AWS CLI
v2 (version and SHA-256 in the `publish` job), `region = auto` and the
endpoint passed in `AWS_ENDPOINT_URL` so the account id never reaches a
command line or a log. It performs **no delete of any kind** — no `s3 rm`, no
`s3 sync` (which mirrors, and would remove old releases to match the build
directory), only individual `put-object` calls. Scratch objects from dry runs
accumulate under `desktop/_dryrun/` until a bucket **lifecycle rule** expires
them; that rule is the bucket owner's to configure and is not part of CI.

### 6. Secrets checklist

| Secret | Required | Purpose |
| --- | --- | --- |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | yes | publishing to app-downloads.zebu.work |
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
it against throwaway repositories, and `scripts/tests/publish-r2.test.sh`
(`npm run test:publish`, which the workflow's first job runs before anything
builds) does the same for the manifest builder and the R2 publisher.

It does **not** touch `zebu-public/downloads.html` — that lives in another
repository and is still step 2 below.

### By hand

1. Bump the version — it must be identical in three places:
   `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`
   (then `cd src-tauri && cargo generate-lockfile --offline` or run
   `cargo check` so `Cargo.lock` follows). The workflow's first job fails if
   the tag disagrees with `tauri.conf.json`/`package.json`.
2. Update the release history and the current version/asset names in
   `zebu-public/downloads.html` (see [Where builds land](#where-builds-land) —
   the stable `desktop/latest/…` names mean only the history needs touching).
3. Commit, tag and push:
   ```bash
   git commit -am "Release 0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```
4. Watch the *Release* workflow. Three build jobs (macOS universal, Windows
   x64, Linux x86_64) attach to the same **draft** release, and the
   `publish` job then puts every built file in R2 and reads it back.
5. Once `publish` is green the update is live: running apps offer it on their
   next launch. Open the draft release on GitHub, check the assets and notes,
   and **Publish** it — that step is now only for the record and for people
   who want the installers from GitHub.

A `workflow_dispatch` run (Actions → Release → Run workflow) is a **dry run**:
it builds all three platforms, uploads the bundles as workflow artifacts, and
publishes them to `desktop/_dryrun/<run id>/` with the same code, credentials
and ordering a release uses — then reads them back, including fetching the
generated manifest over HTTPS and HEADing every URL in it. It never writes
`desktop/latest.json`, `desktop/latest/*` or a real version folder. Use it to
validate signing *and* the whole publishing path before tagging.

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
and signature; Windows installs update through the NSIS installer rather
than the MSI.

## Where builds land

Everything the app and the downloads page fetch lives in the `app-downloads`
R2 bucket, served at `https://app-downloads.zebu.work`:

```
desktop/
  0.2.0/                          every artifact of that build, beside its .sig
    Zebu_0.2.0_universal.dmg
    Zebu_universal.app.tar.gz     Zebu_universal.app.tar.gz.sig
    Zebu_0.2.0_x64-setup.exe      Zebu_0.2.0_x64-setup.exe.sig
    Zebu_0.2.0_x64_en-US.msi      Zebu_0.2.0_x64_en-US.msi.sig
    Zebu_0.2.0_amd64.AppImage     Zebu_0.2.0_amd64.AppImage.sig
    Zebu_0.2.0_amd64.deb
    Zebu-0.2.0-1.x86_64.rpm
  0.1.9/  …                       older releases, kept forever
  latest/                         stable names for a download button
    mac.dmg  windows.exe  linux.AppImage
  latest.json                     the updater manifest
  _dryrun/<run id>/…              workflow_dispatch rehearsals
```

Three things about it are deliberate.

**A version folder is written once and never touched again.** Storage is
negligible next to being able to hand someone the exact build that worked
when a release goes wrong. Nothing in the workflow deletes; `scripts/publish-r2.sh`
contains no delete call at all, which is checked by
`scripts/tests/publish-r2.test.sh`.

**`latest.json` points at the versioned URLs, never at `latest/`.** The
updater verifies a minisign signature against the exact bytes it downloads.
If the manifest named `latest/mac.dmg` and that alias were being overwritten
at the moment an app fetched it — or had already moved on to the next release
— the download would not fail as a 404, it would fail as a *signature error*,
which looks like a compromised update rather than a race. A versioned URL
cannot drift. The aliases exist only for a human clicking a download button;
`scripts/updater-manifest.mjs` refuses a `--base-url` that does not end in the
version being released.

**Upload order is versioned files → aliases → manifest, and the manifest is
last.** An installed copy must never learn about a version before its files
are there.

### Rolling back by hand

The manifest is the only thing that decides what installs offer. To put
everyone back on 0.1.9, rewrite `desktop/latest.json` from the copy that
0.1.9's release produced — its version folder is still there, so the URLs and
signatures are still valid. With the same credentials the workflow uses
(`AWS_ENDPOINT_URL=https://<account id>.r2.cloudflarestorage.com`,
`AWS_DEFAULT_REGION=auto`):

```bash
# Rebuild 0.1.9's manifest from its own files, then put it back in place.
aws s3 cp --recursive s3://app-downloads/desktop/0.1.9/ ./rollback/
node scripts/updater-manifest.mjs \
  --version 0.1.9 --dir ./rollback \
  --base-url https://app-downloads.zebu.work/desktop/0.1.9 \
  > latest.json
aws s3api put-object --bucket app-downloads --key desktop/latest.json \
  --body latest.json --content-type application/json --cache-control no-cache
```

Then point the download aliases back too, if the page matters as much as the
updater:

```bash
aws s3api put-object --bucket app-downloads --key desktop/latest/mac.dmg \
  --body ./rollback/Zebu_0.1.9_universal.dmg \
  --content-type application/x-apple-diskimage --cache-control 'public, max-age=300'
```

Two caveats. Apps already on 0.2.0 will **not** downgrade — the updater only
moves forward — so a rollback stops the spread rather than undoing it; fixing
those needs a 0.2.1. And `latest.json` is served with `Cache-Control: no-cache`
so a rollback is visible immediately, but the aliases are cached for five
minutes.

Do not delete the bad version's folder. Leaving it costs nothing and means
the build is still there to diagnose.

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

To test against the real pipeline instead, run the workflow manually
(Actions → Release → Run workflow) and point an installed build at the dry
run's manifest — `https://app-downloads.zebu.work/desktop/_dryrun/<run id>/latest.json`
— which is a real signed release in every respect except its prefix.

### Where the manifest's shape comes from

`scripts/updater-manifest.mjs` writes the *static* format read by
`tauri-plugin-updater`'s `RemoteRelease` deserializer: `version` (semver, a
leading `v` is tolerated), optional `notes`, optional `pub_date` that **must**
parse as RFC 3339 or the whole manifest is rejected, and `platforms` keyed by
`<os>-<arch>` with `signature` and `url`. The targets come from that crate's
`updater_os()`/`updater_arch()` (`darwin`/`windows`/`linux` × `aarch64`/
`x86_64`), and lookup tries `<os>-<arch>-<installer>` before falling back to
`<os>-<arch>`, so the plain keys serve both. Confirmed by reading
`tauri-plugin-updater-2.11.0/src/updater.rs` — `ReleaseManifestPlatform` and
`RemoteReleaseInner` near the top of the file, `impl Deserialize for
RemoteRelease`, `get_urls()` and `target()` — at the version pinned in
`src-tauri/Cargo.lock`.
