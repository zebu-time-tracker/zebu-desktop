#!/usr/bin/env bash
# Exercises the two pieces a release puts in front of every installed copy of
# the app: scripts/updater-manifest.mjs (what latest.json says) and
# scripts/publish-r2.sh (what goes into the bucket, and in what order).
#
# Neither can be rehearsed by cutting a release, so both are driven here
# against fixtures instead:
#
#   * the manifest builder runs for real against a directory of empty files
#     named exactly as tauri's bundler names them;
#   * publish-r2.sh runs for real with recording stand-ins on $PATH in place
#     of `aws` and `curl`, so the ordering of the actual calls — versioned
#     files, then aliases, then the manifest last — is checked rather than
#     assumed.
#
# Nothing here touches the network, the real bucket, or any credential.
#
#   bash scripts/tests/publish-r2.test.sh
set -u

SELF_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SCRIPTS=$(cd -- "$SELF_DIR/.." && pwd)
MANIFEST_JS=$SCRIPTS/updater-manifest.mjs
PUBLISH=$SCRIPTS/publish-r2.sh
[ -f "$MANIFEST_JS" ] || { echo "FAIL: no updater-manifest.mjs at $MANIFEST_JS"; exit 1; }
[ -f "$PUBLISH" ] || { echo "FAIL: no publish-r2.sh at $PUBLISH"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fails=0
ok()   { printf 'ok   %s\n' "$*"; }
bad()  { printf 'FAIL %s\n' "$*"; fails=$((fails + 1)); }
check() { # name actual expected
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi
}
contains() { # name haystack needle
    if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1 (no '$3' in: $2)"; fi
}
lacks() { # name haystack needle
    if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1 (found '$3')"; else ok "$1"; fi
}

VERSION=0.2.0
PUBLIC=https://app-downloads.zebu.work
BASE_URL=$PUBLIC/desktop/$VERSION

# ---------------------------------------------------------------------------
# Fixtures: the file names tauri's bundler actually produces (docs/release.md)
# ---------------------------------------------------------------------------

# make_bundles <dir> [omit-suffix]
# Every file is one line of made-up content, so sizes differ and a size check
# can be wrong in a detectable way. `omit-suffix` drops the .sig of the
# artifact ending in that suffix, for the missing-signature case.
make_bundles() {
    local dir=$1 omit=${2:-}
    rm -rf "$dir"; mkdir -p "$dir"
    local artifacts="Zebu_universal.app.tar.gz Zebu_${VERSION}_x64-setup.exe Zebu_${VERSION}_x64_en-US.msi Zebu_${VERSION}_amd64.AppImage"
    local plain="Zebu_${VERSION}_universal.dmg Zebu_${VERSION}_amd64.deb Zebu-${VERSION}-1.x86_64.rpm"
    local f
    for f in $artifacts; do
        printf 'payload of %s\n' "$f" > "$dir/$f"
        if [ -n "$omit" ] && case "$f" in *"$omit") true ;; *) false ;; esac; then continue; fi
        printf 'sig-for-%s\n' "$f" > "$dir/$f.sig"
    done
    for f in $plain; do printf 'payload of %s\n' "$f" > "$dir/$f"; done
}

BUNDLES=$TMP/bundles
make_bundles "$BUNDLES"

run_manifest() { # args... -> $out, $rc
    out=$(node "$MANIFEST_JS" "$@" 2>&1)
    rc=$?
}

json() { # <manifest json> <node expression over `m`>
    printf '%s' "$1" | node -e '
        let raw = ""; process.stdin.on("data", (c) => raw += c);
        process.stdin.on("end", () => {
            const m = JSON.parse(raw);
            const out = eval(process.argv[1]);
            console.log(typeof out === "string" ? out : JSON.stringify(out));
        });
    ' "$2"
}

# ---------------------------------------------------------------------------
# The manifest: shape
# ---------------------------------------------------------------------------

run_manifest --version "$VERSION" --dir "$BUNDLES" --base-url "$BASE_URL" --aliases-out "$TMP/aliases.tsv"
check "manifest builds from a full set of bundles" "$rc" "0"
MANIFEST=$out

# The shape tauri-plugin-updater's RemoteRelease deserializer reads: `version`
# (semver), optional `notes`, optional RFC 3339 `pub_date`, and `platforms`
# keyed by `<os>-<arch>` with `signature` and `url`.
check "top-level keys are the ones the updater reads" \
    "$(json "$MANIFEST" 'Object.keys(m).sort().join(",")')" "notes,platforms,pub_date,version"
check "names the version being released" "$(json "$MANIFEST" 'm.version')" "$VERSION"
check "every platform is a {signature,url} pair, nothing else" \
    "$(json "$MANIFEST" 'Object.values(m.platforms).map((p) => Object.keys(p).sort().join("+")).join(",")')" \
    "signature+url,signature+url,signature+url,signature+url"
check "covers the four targets the app is built for" \
    "$(json "$MANIFEST" 'Object.keys(m.platforms).sort().join(",")')" \
    "darwin-aarch64,darwin-x86_64,linux-x86_64,windows-x86_64"
check "pub_date is RFC 3339 (anything else fails the whole manifest to parse)" \
    "$(json "$MANIFEST" '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(m.pub_date) ? "yes" : m.pub_date')" \
    "yes"

# ---------------------------------------------------------------------------
# The manifest: versioned URLs, never the aliases
# ---------------------------------------------------------------------------

check "every URL sits under the immutable per-version prefix" \
    "$(json "$MANIFEST" 'Object.values(m.platforms).every((p) => p.url.startsWith("'"$BASE_URL"'/")) ? "yes" : "no"')" \
    "yes"
lacks "no URL points at a moving alias" "$MANIFEST" "/desktop/latest/"
lacks "no URL points at the latest alias directory at all" "$MANIFEST" "latest/mac.dmg"

check "windows updates through the NSIS installer, not the MSI" \
    "$(json "$MANIFEST" 'm.platforms["windows-x86_64"].url.split("/").pop()')" \
    "Zebu_${VERSION}_x64-setup.exe"
check "linux updates through the AppImage" \
    "$(json "$MANIFEST" 'm.platforms["linux-x86_64"].url.split("/").pop()')" \
    "Zebu_${VERSION}_amd64.AppImage"
check "both mac arches take the one universal bundle" \
    "$(json "$MANIFEST" 'm.platforms["darwin-aarch64"].url === m.platforms["darwin-x86_64"].url ? m.platforms["darwin-aarch64"].url.split("/").pop() : "differ"')" \
    "Zebu_universal.app.tar.gz"

check "signatures are the contents of the .sig files" \
    "$(json "$MANIFEST" 'm.platforms["linux-x86_64"].signature')" \
    "sig-for-Zebu_${VERSION}_amd64.AppImage"
check "every platform carries a signature" \
    "$(json "$MANIFEST" 'Object.values(m.platforms).every((p) => p.signature.length > 0) ? "yes" : "no"')" "yes"

check "two runs of the same inputs agree" \
    "$(node "$MANIFEST_JS" --version "$VERSION" --dir "$BUNDLES" --base-url "$BASE_URL" --pub-date 2026-01-01T00:00:00Z)" \
    "$(node "$MANIFEST_JS" --version "$VERSION" --dir "$BUNDLES" --base-url "$BASE_URL" --pub-date 2026-01-01T00:00:00Z)"

# ---------------------------------------------------------------------------
# The manifest: refusals. A half-built manifest is worse than no release.
# ---------------------------------------------------------------------------

refuses_manifest() { # name expected-substring args...
    local name=$1 want=$2; shift 2
    run_manifest "$@"
    if [ "$rc" = 0 ]; then bad "$name (exited 0, expected a refusal)"
    elif ! printf '%s' "$out" | grep -qF -- "$want"; then bad "$name (no '$want' in: $out)"
    else ok "$name"; fi
}

NOSIG=$TMP/nosig
make_bundles "$NOSIG" ".AppImage"
refuses_manifest "a missing signature is an error, not a quiet omission" "has no signature beside it" \
    --version "$VERSION" --dir "$NOSIG" --base-url "$BASE_URL"
run_manifest --version "$VERSION" --dir "$NOSIG" --base-url "$BASE_URL"
lacks "and nothing partial is printed when it refuses" "$out" '"platforms"'

refuses_manifest "refuses a base URL pointing at the alias directory" "must end in the version" \
    --version "$VERSION" --dir "$BUNDLES" --base-url "$PUBLIC/desktop/latest"
refuses_manifest "refuses a base URL for a different version" "must end in the version" \
    --version "$VERSION" --dir "$BUNDLES" --base-url "$PUBLIC/desktop/0.1.9"
refuses_manifest "refuses plain http" "must be https" \
    --version "$VERSION" --dir "$BUNDLES" --base-url "http://app-downloads.zebu.work/desktop/$VERSION"
refuses_manifest "refuses a version that is not X.Y.Z" "is not X.Y.Z" \
    --version v0.2.0 --dir "$BUNDLES" --base-url "$BASE_URL"
refuses_manifest "refuses a pub_date the updater cannot parse" "is not RFC 3339" \
    --version "$VERSION" --dir "$BUNDLES" --base-url "$BASE_URL" --pub-date "11 Sep 2026"
refuses_manifest "refuses a directory with no updater artifacts" "no updater artifacts found" \
    --version "$VERSION" --dir "$TMP" --base-url "$BASE_URL"
refuses_manifest "refuses a directory it cannot read" "cannot read --dir" \
    --version "$VERSION" --dir "$TMP/not-there" --base-url "$BASE_URL"
refuses_manifest "refuses an unknown option" "unknown option" \
    --version "$VERSION" --dir "$BUNDLES" --base-url "$BASE_URL" --prune

AMBIG=$TMP/ambiguous
make_bundles "$AMBIG"
cp "$AMBIG/Zebu_${VERSION}_universal.dmg" "$AMBIG/Zebu_${VERSION}_intel.dmg"
refuses_manifest "refuses to guess between two candidate downloads" "cannot tell which to publish" \
    --version "$VERSION" --dir "$AMBIG" --base-url "$BASE_URL"

# ---------------------------------------------------------------------------
# The aliases a download page links to
# ---------------------------------------------------------------------------

check "alias plan names the installers, not the updater artifacts" \
    "$(tr '\t' '=' < "$TMP/aliases.tsv" | tr '\n' ' ')" \
    "mac.dmg=Zebu_${VERSION}_universal.dmg windows.exe=Zebu_${VERSION}_x64-setup.exe linux.AppImage=Zebu_${VERSION}_amd64.AppImage "

# ---------------------------------------------------------------------------
# publish-r2.sh: the plan, and the order it is written in
# ---------------------------------------------------------------------------

MANIFEST_FILE=$TMP/latest.json
printf '%s\n' "$MANIFEST" > "$MANIFEST_FILE"

plan_for() { # base -> plan on stdout
    bash "$PUBLISH" publish --bucket app-downloads --base "$1" --version "$VERSION" \
        --dir "$BUNDLES" --manifest "$MANIFEST_FILE" --aliases "$TMP/aliases.tsv" \
        --public-base "$PUBLIC" --print-plan
}

REAL_PLAN=$(plan_for desktop)
phases=$(printf '%s\n' "$REAL_PLAN" | cut -f1 | uniq | tr '\n' ' ')
check "versioned files go up first, then the aliases, then the manifest" \
    "$phases" "versioned alias manifest "
check "the manifest is the very last object written" \
    "$(printf '%s\n' "$REAL_PLAN" | tail -1 | cut -f2)" "desktop/latest.json"
check "every artifact is kept under its own version" \
    "$(printf '%s\n' "$REAL_PLAN" | awk -F'\t' '$1 == "versioned"' | cut -f2 | grep -cv "^desktop/$VERSION/")" "0"
check "all nine built files are published" \
    "$(printf '%s\n' "$REAL_PLAN" | awk -F'\t' '$1 == "versioned"' | wc -l | tr -d ' ')" \
    "$(find "$BUNDLES" -type f | wc -l | tr -d ' ')"
check "the three aliases are written from the versioned originals" \
    "$(printf '%s\n' "$REAL_PLAN" | awk -F'\t' '$1 == "alias"' | cut -f2 | tr '\n' ' ')" \
    "desktop/latest/mac.dmg desktop/latest/windows.exe desktop/latest/linux.AppImage "

# ---------------------------------------------------------------------------
# publish-r2.sh: a dry run cannot reach anything real
# ---------------------------------------------------------------------------

DRY_PLAN=$(plan_for desktop/_dryrun/4242)
check "a dry run writes only under its own run's prefix" \
    "$(printf '%s\n' "$DRY_PLAN" | cut -f2 | grep -cv '^desktop/_dryrun/4242/')" "0"
lacks "a dry run never writes the real manifest" "$(printf '%s\n' "$DRY_PLAN" | cut -f2)" "desktop/latest.json"
lacks "a dry run never writes a real alias" "$(printf '%s\n' "$DRY_PLAN" | cut -f2)" "desktop/latest/"
lacks "a dry run never writes a real version folder" "$(printf '%s\n' "$DRY_PLAN" | cut -f2)" "desktop/$VERSION/"
check "a dry run still takes the same three phases in the same order" \
    "$(printf '%s\n' "$DRY_PLAN" | cut -f1 | uniq | tr '\n' ' ')" "versioned alias manifest "
check "a dry run publishes exactly as many objects as a real one" \
    "$(printf '%s\n' "$DRY_PLAN" | wc -l | tr -d ' ')" "$(printf '%s\n' "$REAL_PLAN" | wc -l | tr -d ' ')"

refuses_publish() { # name expected-substring base
    local name=$1 want=$2 the_base=$3
    out=$(bash "$PUBLISH" publish --bucket app-downloads --base "$the_base" --version "$VERSION" \
        --dir "$BUNDLES" --manifest "$MANIFEST_FILE" --aliases "$TMP/aliases.tsv" --print-plan 2>&1)
    rc=$?
    if [ "$rc" = 0 ]; then bad "$name (exited 0, expected a refusal)"
    elif ! printf '%s' "$out" | grep -qF -- "$want"; then bad "$name (no '$want' in: $out)"
    else ok "$name"; fi
}

refuses_publish "refuses an empty base rather than writing to the bucket root" "'' is neither" ""
refuses_publish "refuses a base that is not the two it knows" "is neither" "desktop/latest"
refuses_publish "refuses a dry-run prefix with no run id" "is neither" "desktop/_dryrun/"
refuses_publish "refuses someone else's prefix" "is neither" "../desktop"

# The strongest guarantee about deletion is that there is nothing to guard:
# the workflow cannot remove a real release however wrong its variables get.
# Comments are stripped first — the header explains the absence.
check "the publish script contains no delete of any kind" \
    "$(grep -v '^[[:space:]]*#' "$PUBLISH" | grep -cE '(s3 +rm|delete-object|delete-objects|--delete([^a-z]|$)|s3 +sync)')" "0"

# ---------------------------------------------------------------------------
# publish-r2.sh: the calls it actually makes
# ---------------------------------------------------------------------------
# Stand-ins for `aws` and `curl` that record their arguments. The aws one
# keeps a key -> size store from the put-objects it sees, so head-object
# answers with what was really uploaded and a wrong prefix cannot pass.

STUB=$TMP/stub
mkdir -p "$STUB"

cat > "$STUB/aws" <<'STUB_AWS'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$AWS_LOG"
op=$2
key=''; body=''; disposition=''
while [ $# -gt 0 ]; do
    case $1 in
        --key) key=$2; shift 2 ;;
        --body) body=$2; shift 2 ;;
        --content-disposition) disposition=$2; shift 2 ;;
        *) shift ;;
    esac
done
case $op in
    put-object)
        size=$(wc -c < "$body" | tr -d ' ')
        printf '%s\t%s\t%s\n' "$key" "$size" "$disposition" >> "$AWS_STORE"
        printf '"stub-etag"\n'
        ;;
    head-object)
        # Answers with what was really put, so the script cannot pass by
        # reading back something it never wrote.
        line=$(awk -F'\t' -v k="$key" '$1 == k' "$AWS_STORE" | tail -1)
        [ -n "$line" ] || { echo "stub: no such key $key" >&2; exit 1; }
        size=$(printf '%s' "$line" | cut -f2)
        stored=$(printf '%s' "$line" | cut -f3-)
        # Simulates a bucket that accepted the put but did not keep the header.
        [ -n "${AWS_STUB_DROP_DISPOSITION:-}" ] && stored=''
        # aws --output text renders a two-element query as one tab-separated
        # line, and an absent header as the literal None.
        printf '%s\t%s\n' "$((size + ${AWS_STUB_SIZE_SKEW:-0}))" "${stored:-None}"
        ;;
    *) echo "stub: unexpected aws $op" >&2; exit 1 ;;
esac
STUB_AWS

cat > "$STUB/curl" <<'STUB_CURL'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$CURL_LOG"
head=false
url=''
for arg in "$@"; do
    case $arg in
        -I) head=true ;;
        http*) url=$arg ;;
    esac
done
if [ "$head" = true ]; then
    case " ${CURL_404:-} " in *" $url "*) echo "stub: 404 $url" >&2; exit 22 ;; esac
    printf 'HTTP/2 200\n'
else
    cat "$CURL_BODY"
fi
STUB_CURL
chmod +x "$STUB/aws" "$STUB/curl"

run_publish() { # base [env assignments handled by caller] -> $out, $rc
    AWS_LOG=$TMP/aws.log CURL_LOG=$TMP/curl.log AWS_STORE=$TMP/aws.store CURL_BODY=$MANIFEST_FILE \
    AWS_BIN="$STUB/aws" CURL_BIN="$STUB/curl" AWS_ENDPOINT_URL="https://SECRET-ACCOUNT.r2.cloudflarestorage.com" \
    AWS_STUB_SIZE_SKEW="${SKEW:-0}" CURL_404="${MISSING:-}" \
    AWS_STUB_DROP_DISPOSITION="${DROP_DISPOSITION:-}" \
        bash "$PUBLISH" publish --bucket app-downloads --base "$1" --version "$VERSION" \
            --dir "$BUNDLES" --manifest "$MANIFEST_FILE" --aliases "$TMP/aliases.tsv" \
            --public-base "$PUBLIC" 2>&1
    rc=$?
}

SKEW=0
MISSING=''
: > "$TMP/aws.log"; : > "$TMP/curl.log"; : > "$TMP/aws.store"
out=$(run_publish desktop/_dryrun/4242; printf 'RC=%s' "$rc")
rc=${out##*RC=}
out=${out%RC=*}
check "a full publish run succeeds against the stand-ins" "$rc" "0"

PUT_ORDER=$(grep '^s3api put-object' "$TMP/aws.log" | sed 's/.*--key \([^ ]*\).*/\1/')
check "the last object put is the manifest" \
    "$(printf '%s\n' "$PUT_ORDER" | tail -1)" "desktop/_dryrun/4242/latest.json"
check "no alias is written before every versioned file is up" \
    "$(printf '%s\n' "$PUT_ORDER" | grep -n '/latest/' | head -1 | cut -d: -f1)" \
    "$(( $(printf '%s\n' "$PUT_ORDER" | grep -c "/_dryrun/4242/$VERSION/") + 1 ))"
check "every uploaded object is read back afterwards" \
    "$(grep -c '^s3api head-object' "$TMP/aws.log")" "$(printf '%s\n' "$PUT_ORDER" | wc -l | tr -d ' ')"
check "the published manifest is fetched over the public hostname" \
    "$(grep -c 'app-downloads.zebu.work/desktop/_dryrun/4242/latest.json' "$TMP/curl.log")" "1"
check "every URL in the manifest is HEADed" \
    "$(grep -c -- '-I' "$TMP/curl.log")" "4"

# ---------------------------------------------------------------------------
# The aliases download under their versioned name
# ---------------------------------------------------------------------------
# A stable link is what a download page needs; `mac.dmg` sitting in a Downloads
# folder is not what a person needs. The object carries the name it was copied
# from, so the two are allowed to differ.

alias_disposition() { # alias key -> the --content-disposition it was put with
    grep "^s3api put-object .*--key $1 " "$TMP/aws.log" | tail -1 |
        sed -n 's/.*--content-disposition \(.*\) --output.*/\1/p'
}

check "the mac alias downloads under its version" \
    "$(alias_disposition desktop/_dryrun/4242/latest/mac.dmg)" \
    "attachment; filename=\"Zebu_${VERSION}_universal.dmg\""
check "the windows alias downloads under its version" \
    "$(alias_disposition desktop/_dryrun/4242/latest/windows.exe)" \
    "attachment; filename=\"Zebu_${VERSION}_x64-setup.exe\""
check "the linux alias downloads under its version" \
    "$(alias_disposition desktop/_dryrun/4242/latest/linux.AppImage)" \
    "attachment; filename=\"Zebu_${VERSION}_amd64.AppImage\""

# The manifest is fetched and parsed by the updater, not saved by a person, and
# a versioned file is already named for its version.
check "nothing but the aliases is turned into a download" \
    "$(grep -c -- '--content-disposition' "$TMP/aws.log")" "3"

# A publish whose aliases lost the header must fail rather than ship a bucket
# full of files called mac.dmg. Same run, with the stub dropping it.
: > "$TMP/aws.log"; : > "$TMP/curl.log"; : > "$TMP/aws.store"
DROP_DISPOSITION=1
out=$(run_publish desktop/_dryrun/4242; printf 'RC=%s' "$rc")
DROP_DISPOSITION=''
rc=${out##*RC=}
check "a publish that loses the download name fails" "$rc" "1"
contains "and says which object and what it wanted" "${out%RC=*}" \
    "wanted Zebu_${VERSION}_universal.dmg"
lacks "the account id never reaches the output" "$out" "SECRET-ACCOUNT"
lacks "nor does the endpoint" "$out" "r2.cloudflarestorage.com"

# A truncated upload must stop the release rather than be published.
SKEW=1
MISSING=''
: > "$TMP/aws.log"; : > "$TMP/aws.store"
out=$(run_publish desktop/_dryrun/4242; printf 'RC=%s' "$rc")
rc=${out##*RC=}
contains "a size that disagrees with the upload fails the run" "${out%RC=*}" "bytes in the bucket"
if [ "$rc" = 0 ]; then bad "a size mismatch exits non-zero"; else ok "a size mismatch exits non-zero"; fi

# A manifest URL that does not resolve is the wrong-prefix / not-public case.
SKEW=0
MISSING=$(json "$MANIFEST" 'm.platforms["linux-x86_64"].url')
: > "$TMP/aws.log"; : > "$TMP/aws.store"; : > "$TMP/curl.log"
out=$(run_publish desktop/_dryrun/4242; printf 'RC=%s' "$rc")
rc=${out##*RC=}
contains "a manifest URL that 404s fails the run" "${out%RC=*}" "does not resolve"
if [ "$rc" = 0 ]; then bad "an unresolvable URL exits non-zero"; else ok "an unresolvable URL exits non-zero"; fi

# Without the endpoint the AWS CLI would quietly address real AWS.
SKEW=0
MISSING=''
: > "$TMP/aws.log"; : > "$TMP/aws.store"
out=$(AWS_LOG=$TMP/aws.log CURL_LOG=$TMP/curl.log AWS_STORE=$TMP/aws.store CURL_BODY=$MANIFEST_FILE \
    AWS_BIN="$STUB/aws" CURL_BIN="$STUB/curl" \
    bash "$PUBLISH" publish --bucket app-downloads --base desktop --version "$VERSION" \
        --dir "$BUNDLES" --manifest "$MANIFEST_FILE" --aliases "$TMP/aliases.tsv" 2>&1)
rc=$?
contains "refuses to run without the R2 endpoint" "$out" "AWS_ENDPOINT_URL is not set"
check "and uploads nothing" "$(grep -c put-object "$TMP/aws.log")" "0"

echo
if [ "$fails" = 0 ]; then echo "all passed"; else echo "$fails failed"; exit 1; fi
