#!/usr/bin/env bash
# Cut a Zebu Desktop release in one go: pick the next version, prove the tree
# is releasable, run the repo's own gate, write the version into all three
# files (plus both lockfiles), then commit, tag and push.
#
#   scripts/release.sh                 # 0.1.4 -> 0.1.5
#   scripts/release.sh --minor         # 0.1.4 -> 0.2.0
#   scripts/release.sh --major         # 0.1.4 -> 1.0.0
#   scripts/release.sh 0.3.0           # exactly that
#   scripts/release.sh --dry-run       # print every step and diff, touch nothing
#   scripts/release.sh --skip-checks   # skip npm test / lint / cargo test (loud)
#
# The version lives in package.json, src-tauri/tauri.conf.json and
# src-tauri/Cargo.toml, and the workflow's first job refuses a tag that
# disagrees with the first two — which is why doing this by hand has already
# produced an empty release. Runs from anywhere: it works on the repository
# the script itself lives in.
#
# Version parsing, bumping and the file rewrites are plain functions with no
# side effects, so scripts/tests/release.test.sh can source this file and call
# them; everything that touches git or the network is behind run_checks(),
# preflight() and commit_tag_push().

# ---------------------------------------------------------------------------
# Paths and output
# ---------------------------------------------------------------------------

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

PKG_JSON="package.json"
TAURI_JSON="src-tauri/tauri.conf.json"
CARGO_TOML="src-tauri/Cargo.toml"
NPM_LOCK="package-lock.json"
CARGO_LOCK="src-tauri/Cargo.lock"

DRY_RUN=0
SKIP_CHECKS=0
RELEASE_TMP=""

cleanup() { [ -n "$RELEASE_TMP" ] && rm -rf "$RELEASE_TMP"; return 0; }

log()  { printf '\033[1;32m▸\033[0m %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
# In a dry run, say what would happen instead of doing it.
would() { printf '\033[1;34m·\033[0m would %s\n' "$*"; }

usage() {
    cat <<'USAGE'
Usage: scripts/release.sh [X.Y.Z] [--major|--minor|--patch] [options]

Version (default: --patch, i.e. the next version — 0.1.4 becomes 0.1.5):
  X.Y.Z            release exactly this version (overrides the bump flags)
  --major          1.2.3 -> 2.0.0
  --minor          1.2.3 -> 1.3.0
  --patch          1.2.3 -> 1.2.4  (the default)

Options:
  -n, --dry-run    print every step and every file change, touch nothing
      --skip-checks  do not run npm test / npm run lint / cargo test
  -h, --help       this text

Refuses to run if the tree is dirty, the branch is not main, main is behind
or diverged from origin/main, the tag already exists locally or on origin, or
the target version is not greater than the current one.
USAGE
}

# ---------------------------------------------------------------------------
# Pure version helpers (no side effects — the test suite calls these directly)
# ---------------------------------------------------------------------------

# Three dot-separated numbers, nothing else. No "v", no pre-release suffix:
# the release workflow compares the tag to these files literally.
version_is_valid() {
    [[ ${1:-} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# bump_version <current> <major|minor|patch> -> the next version on stdout
bump_version() {
    local current=${1:-} mode=${2:-patch} major minor patch rest
    version_is_valid "$current" || return 1
    major=${current%%.*}
    rest=${current#*.}
    minor=${rest%%.*}
    patch=${rest#*.}
    # 10# so a component written as 08 is decimal eight, not a bad octal digit.
    case $mode in
        major) printf '%s.0.0\n' "$((10#$major + 1))" ;;
        minor) printf '%s.%s.0\n' "$((10#$major))" "$((10#$minor + 1))" ;;
        patch) printf '%s.%s.%s\n' "$((10#$major))" "$((10#$minor))" "$((10#$patch + 1))" ;;
        *) return 1 ;;
    esac
}

# version_gt <a> <b> — true when a is strictly newer than b.
version_gt() {
    local a=${1:-} b=${2:-}
    version_is_valid "$a" && version_is_valid "$b" || return 1
    [ "$a" != "$b" ] || return 1
    [ "$(printf '%s\n%s\n' "$a" "$b" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$b" ]
}

# ---------------------------------------------------------------------------
# Reading and rewriting the version in each file
#
# These edit one line in place rather than reserialising, so the files keep
# their formatting and key order — and, more importantly, so that only the
# *top-level* "version" in a JSON file and only the version under [package] in
# Cargo.toml can ever be touched. A dependency's version is never a candidate.
# ---------------------------------------------------------------------------

# read_json_version <file> — the value of the top-level "version" key.
read_json_version() {
    awk '
        {
            line = $0
            bare = line
            gsub(/"([^"\\]|\\.)*"/, "@@", bare)   # blank out strings before counting braces
        }
        depth == 1 && line ~ /^[[:space:]]*"version"[[:space:]]*:/ {
            if (match(line, /:[[:space:]]*"[^"]*"/)) {
                v = substr(line, RSTART, RLENGTH)
                sub(/^:[[:space:]]*"/, "", v)
                sub(/"$/, "", v)
                print v
                exit
            }
        }
        { depth += gsub(/\{/, "{", bare) - gsub(/\}/, "}", bare) }
    ' "$1"
}

# write_json_version <file> <version> <out> — <file> with only the top-level
# "version" changed, written to <out>.
write_json_version() {
    awk -v ver="$2" '
        {
            line = $0
            bare = line
            gsub(/"([^"\\]|\\.)*"/, "@@", bare)
        }
        !done && depth == 1 && line ~ /^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"[^"]*"/ {
            sub(/"version"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"version\": \"" ver "\"", line)
            done = 1
        }
        { print line; depth += gsub(/\{/, "{", bare) - gsub(/\}/, "}", bare) }
        END { if (!done) exit 1 }
    ' "$1" > "$3"
}

# read_cargo_version <file> — the version under [package].
read_cargo_version() {
    read_cargo_key "$1" version
}

# read_cargo_name <file> — the name under [package] (the key Cargo.lock files it under).
read_cargo_name() {
    read_cargo_key "$1" name
}

read_cargo_key() {
    awk -v key="$2" '
        /^[[:space:]]*\[/ { section = $0; gsub(/[[:space:]]/, "", section) }
        section == "[package]" && $0 ~ ("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*\"") {
            if (match($0, /"[^"]*"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
        }
    ' "$1"
}

# write_cargo_version <file> <version> <out>
write_cargo_version() {
    awk -v ver="$2" '
        /^[[:space:]]*\[/ { section = $0; gsub(/[[:space:]]/, "", section) }
        !done && section == "[package]" && /^[[:space:]]*version[[:space:]]*=[[:space:]]*"/ {
            print "version = \"" ver "\""
            done = 1
            next
        }
        { print }
        END { if (!done) exit 1 }
    ' "$1" > "$3"
}

# current_version — the one truth we bump from, plus a check that the other
# two files agree with it. A repo where they already disagree is a repo where
# somebody bumped by hand and stopped halfway; say so rather than paper over it.
current_version() {
    local pkg tauri cargo
    pkg=$(read_json_version "$ROOT/$PKG_JSON")
    tauri=$(read_json_version "$ROOT/$TAURI_JSON")
    cargo=$(read_cargo_version "$ROOT/$CARGO_TOML")
    version_is_valid "$pkg" || die "cannot read a version from $PKG_JSON"
    if [ "$pkg" != "$tauri" ] || [ "$pkg" != "$cargo" ]; then
        die "the three version fields already disagree ($PKG_JSON $pkg, $TAURI_JSON $tauri, $CARGO_TOML $cargo) — fix them by hand first"
    fi
    printf '%s\n' "$pkg"
}

# apply_versions <version> — rewrite the three files (or, in a dry run, show
# the diff each rewrite would make).
apply_versions() {
    local version=$1 tmp file kind
    # Cleaned up by cleanup() on exit, so the die()s below leak nothing.
    RELEASE_TMP=$(mktemp -d)
    tmp=$RELEASE_TMP

    for file in "$PKG_JSON" "$TAURI_JSON" "$CARGO_TOML"; do
        if [ "$file" = "$CARGO_TOML" ]; then kind=cargo; else kind=json; fi
        mkdir -p "$tmp/$(dirname "$file")"
        if [ "$kind" = json ]; then
            write_json_version "$ROOT/$file" "$version" "$tmp/$file" \
                || die "no top-level \"version\" key in $file"
        else
            write_cargo_version "$ROOT/$file" "$version" "$tmp/$file" \
                || die "no version under [package] in $file"
        fi

        if [ "$DRY_RUN" = 1 ]; then
            would "change $file:"
            diff -u --label "a/$file" --label "b/$file" "$ROOT/$file" "$tmp/$file" \
                | sed -n '3,$p' | sed 's/^/    /' || true
        else
            cat "$tmp/$file" > "$ROOT/$file"
            note "$file -> $version"
        fi
    done
}

# update_lockfiles <version> — package-lock.json carries the version twice and
# Cargo.lock once; neither is edited by hand, each tool rewrites its own.
update_lockfiles() {
    local version=$1
    if [ "$DRY_RUN" = 1 ]; then
        would "run npm install --package-lock-only  (brings $NPM_LOCK to $version)"
        would "run cargo check in src-tauri         (brings $CARGO_LOCK to $version)"
        return 0
    fi
    log "Bringing the lockfiles along"
    (cd "$ROOT" && npm install --package-lock-only --silent) \
        || die "npm install --package-lock-only failed"
    note "$NPM_LOCK -> $(read_json_version "$ROOT/$NPM_LOCK")"
    (cd "$ROOT/src-tauri" && cargo check --quiet) \
        || die "cargo check failed — $CARGO_LOCK was not updated"
    note "$CARGO_LOCK -> $version"
}

# verify_versions <version> — belt and braces before anything is committed:
# every file the release workflow reads must now say the same thing.
verify_versions() {
    local version=$1 got crate
    for got in \
        "$PKG_JSON:$(read_json_version "$ROOT/$PKG_JSON")" \
        "$TAURI_JSON:$(read_json_version "$ROOT/$TAURI_JSON")" \
        "$NPM_LOCK:$(read_json_version "$ROOT/$NPM_LOCK")"
    do
        [ "${got#*:}" = "$version" ] || die "${got%%:*} says ${got#*:}, not $version"
    done
    got=$(read_cargo_version "$ROOT/$CARGO_TOML")
    [ "$got" = "$version" ] || die "$CARGO_TOML says $got, not $version"

    crate=$(read_cargo_name "$ROOT/$CARGO_TOML")
    if ! awk -v ver="$version" -v crate="$crate" '
            $0 == "name = \"" crate "\"" { want = 1; next }
            want && /^version = / { ok = ($0 == "version = \"" ver "\""); exit }
            END { exit ok ? 0 : 1 }
        ' "$ROOT/$CARGO_LOCK"; then
        die "$CARGO_LOCK does not carry $version for $crate"
    fi
}

# ---------------------------------------------------------------------------
# git, the network and the repo's gate
# ---------------------------------------------------------------------------

# preflight <version> <current> — every reason to refuse, checked before a
# single file is touched. Each one exits non-zero with the reason on one line.
preflight() {
    local version=$1 current=$2 branch counts behind

    version_gt "$version" "$current" \
        || die "$version is not newer than the current $current"

    git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 \
        || die "$ROOT is not a git repository"
    git -C "$ROOT" remote get-url origin >/dev/null 2>&1 \
        || die "this repository has no 'origin' remote to push to"

    [ -z "$(git -C "$ROOT" status --porcelain)" ] \
        || die "the working tree is dirty — commit or stash first (git status)"

    branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)
    [ "$branch" = main ] \
        || die "on branch '$branch' — releases are cut from main"

    log "Fetching origin"
    git -C "$ROOT" fetch --quiet --tags origin \
        || die "git fetch origin failed — no network, or no access to origin"

    git -C "$ROOT" rev-parse --verify --quiet origin/main >/dev/null \
        || die "origin/main does not exist"
    # left = commits only origin/main has, right = commits only we have.
    counts=$(git -C "$ROOT" rev-list --left-right --count origin/main...HEAD)
    behind=${counts%%[[:space:]]*}
    [ "$behind" = 0 ] \
        || die "main is $behind commit(s) behind origin/main (or diverged) — pull and rebase first"

    # origin first: the fetch above has already copied any remote tag into the
    # local refs, so asking git alone would report every published tag as a
    # merely "local" one.
    if [ -n "$(git -C "$ROOT" ls-remote --tags origin "refs/tags/v$version" 2>/dev/null)" ]; then
        die "tag v$version already exists on origin — that version is already released"
    fi
    if git -C "$ROOT" rev-parse --verify --quiet "refs/tags/v$version" >/dev/null; then
        die "tag v$version already exists locally — delete it (git tag -d v$version) or pick another version"
    fi
}

# run_checks — the same gate the release workflow runs, before anything is
# written, so a red build costs seconds instead of a bad tag.
run_checks() {
    if [ "$SKIP_CHECKS" = 1 ]; then
        warn "--skip-checks: npm test, npm run lint and cargo test are NOT being run."
        warn "               The release workflow runs them anyway, so a failure here"
        warn "               becomes a failed build on a tag that is already public."
        return 0
    fi
    if [ "$DRY_RUN" = 1 ]; then
        would "run npm test"
        would "run npm run lint"
        would "run cargo test in src-tauri"
        return 0
    fi
    log "npm test"
    (cd "$ROOT" && npm test) || die "npm test failed"
    log "npm run lint"
    (cd "$ROOT" && npm run lint) || die "npm run lint failed"
    log "cargo test"
    (cd "$ROOT/src-tauri" && cargo test --quiet) || die "cargo test failed"
}

# commit_tag_push <version> — one commit, one tag, one push carrying both.
commit_tag_push() {
    local version=$1
    local files=("$PKG_JSON" "$TAURI_JSON" "$CARGO_TOML" "$NPM_LOCK" "$CARGO_LOCK")
    if [ "$DRY_RUN" = 1 ]; then
        would "git add ${files[*]}"
        would "git commit -m 'Release $version'"
        would "git tag v$version"
        would "git push origin main v$version"
        return 0
    fi
    log "Committing, tagging and pushing"
    git -C "$ROOT" add -- "${files[@]}"
    git -C "$ROOT" commit --quiet -m "Release $version"
    git -C "$ROOT" tag "v$version"
    git -C "$ROOT" push --quiet origin main "v$version" \
        || die "push failed — the commit and tag v$version exist locally; fix and push again"
    note "pushed main and v$version"
}

# repo_slug — owner/name from origin, for the URLs printed at the end.
repo_slug() {
    local url slug
    url=$(git -C "$ROOT" remote get-url origin 2>/dev/null) || url=""
    url=${url%.git}
    slug=${url##*github.com[:/]}
    # Only trust it when origin really was a github URL and the tail is owner/name.
    case $url:$slug in
        *github.com*:*/*) printf '%s\n' "$slug" ;;
        *) printf 'zebu-time-tracker/zebu-desktop\n' ;;
    esac
}

# what_happens_next <version> — the part that is easy to forget once the tag
# is out: the build is a *draft* release, and the downloads page lives in
# another repository and is not touched by this script.
what_happens_next() {
    local version=$1 slug when="does now"
    slug=$(repo_slug)
    if [ "$DRY_RUN" = 1 ]; then when="would then do"; fi
    echo
    log "What the Release workflow $when"
    note "1. verify: compares v$version with $TAURI_JSON and $PKG_JSON"
    note "2. build:  macOS universal, Windows x64, Linux x86_64 — signed and notarised"
    note "3. all three attach to one DRAFT release; the last also uploads latest.json"
    echo
    note "Watch it:      https://github.com/$slug/actions"
    note "Then publish:  https://github.com/$slug/releases  (the draft is not 'latest' until you do)"
    note "Not automated: bump the version and asset names in zebu-public/downloads.html"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

main() {
    local mode=patch explicit="" version current

    while [ $# -gt 0 ]; do
        case $1 in
            --major) mode=major ;;
            --minor) mode=minor ;;
            --patch) mode=patch ;;
            -n|--dry-run) DRY_RUN=1 ;;
            --skip-checks) SKIP_CHECKS=1 ;;
            -h|--help) usage; return 0 ;;
            -*) die "unknown option: $1 (try --help)" ;;
            *)
                [ -z "$explicit" ] || die "two versions given: $explicit and $1"
                version_is_valid "$1" || die "not a version: '$1' — expected three numbers, like 0.2.0"
                explicit=$1
                ;;
        esac
        shift
    done

    current=$(current_version)
    if [ -n "$explicit" ]; then
        version=$explicit
    else
        version=$(bump_version "$current" "$mode") || die "cannot bump $current"
    fi

    if [ "$DRY_RUN" = 1 ]; then
        log "Dry run — nothing will be written, committed or pushed"
    fi
    log "Releasing $current -> $version"

    preflight "$version" "$current"
    run_checks

    log "Setting the version in three files"
    apply_versions "$version"
    update_lockfiles "$version"
    [ "$DRY_RUN" = 1 ] || verify_versions "$version"

    commit_tag_push "$version"

    if [ "$DRY_RUN" = 1 ]; then
        echo
        log "Dry run finished — the repository is untouched. Re-run without --dry-run to release $version."
    fi
    what_happens_next "$version"
}

# Sourced by the test suite: define the functions and stop. Run as a script:
# strict mode and go.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    set -euo pipefail
    trap cleanup EXIT
    main "$@"
fi
