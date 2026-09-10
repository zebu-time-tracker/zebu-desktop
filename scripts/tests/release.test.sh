#!/usr/bin/env bash
# Exercises scripts/release.sh, so the thing that cuts releases is proven
# rather than assumed. Two halves:
#
#   * the pure helpers (version_is_valid, bump_version, version_gt, and the
#     file rewriters) are sourced out of release.sh and called directly;
#   * everything else runs the real script inside a throwaway git repository
#     in a temp directory, with its own bare "origin". Nothing here ever
#     touches this repository, the real remote, or the real tags.
#
#   bash scripts/tests/release.test.sh [path/to/release.sh]
set -u

SELF_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
RELEASE=${1:-$SELF_DIR/../release.sh}
[ -f "$RELEASE" ] || { echo "FAIL: no release.sh at $RELEASE"; exit 1; }
RELEASE=$(cd -- "$(dirname -- "$RELEASE")" && pwd)/$(basename -- "$RELEASE")

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

UNITS=$TMP/units
mkdir -p "$UNITS"

fails=0
ok()   { printf 'ok   %s\n' "$*"; }
bad()  { printf 'FAIL %s\n' "$*"; fails=$((fails + 1)); }
check() { # name actual expected
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi
}

# The helpers are defined by sourcing; release.sh only runs main() when it is
# the program being executed, so this defines the functions and stops.
# shellcheck disable=SC1090
. "$RELEASE"

# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

check "default bump is the next version" "$(bump_version 0.1.4 patch)" "0.1.5"
check "patch carries past nine"          "$(bump_version 0.1.9 patch)" "0.1.10"
check "--minor zeroes the patch"         "$(bump_version 0.1.4 minor)" "0.2.0"
check "--major zeroes the rest"          "$(bump_version 0.1.4 major)" "1.0.0"
check "no leading-zero octal surprise"   "$(bump_version 0.8.08 patch)" "0.8.9"

for good in 0.0.0 1.2.3 10.20.30; do
    if version_is_valid "$good"; then ok "accepts $good"; else bad "accepts $good"; fi
done
for bad_v in v1.2.3 1.2 1.2.3.4 1.2.x "" "1.2.3-beta"; do
    if version_is_valid "$bad_v"; then bad "rejects '$bad_v'"; else ok "rejects '$bad_v'"; fi
done

if version_gt 0.2.0 0.1.9; then ok "0.2.0 > 0.1.9"; else bad "0.2.0 > 0.1.9"; fi
if version_gt 0.1.10 0.1.9; then ok "0.1.10 > 0.1.9 (numeric, not lexical)"; else bad "0.1.10 > 0.1.9"; fi
if version_gt 0.1.4 0.1.4; then bad "0.1.4 is not > itself"; else ok "0.1.4 is not > itself"; fi
if version_gt 0.1.3 0.1.4; then bad "0.1.3 is not > 0.1.4"; else ok "0.1.3 is not > 0.1.4"; fi

# ---------------------------------------------------------------------------
# The rewriters only touch the field they are meant to
# ---------------------------------------------------------------------------

cat > "$UNITS/conf.json" <<'JSON'
{
    "productName": "Zebu",
    "version": "0.1.4",
    "plugins": {
        "updater": {
            "version": "do-not-touch"
        }
    }
}
JSON
check "reads the top-level json version" "$(read_json_version "$UNITS/conf.json")" "0.1.4"
write_json_version "$UNITS/conf.json" 0.1.5 "$UNITS/conf.out.json"
check "writes the top-level json version" "$(read_json_version "$UNITS/conf.out.json")" "0.1.5"
check "leaves a nested version alone" \
    "$(grep -c 'do-not-touch' "$UNITS/conf.out.json")" "1"
check "changes exactly one line" \
    "$(diff "$UNITS/conf.json" "$UNITS/conf.out.json" | grep -c '^[<>]')" "2"

cat > "$UNITS/Cargo.toml" <<'TOML'
[package]
name = "zebu-desktop"
version = "0.1.4"
edition = "2021"

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }

[package.metadata.decoy]
version = "9.9.9"

[workspace]
TOML
check "reads the [package] version" "$(read_cargo_version "$UNITS/Cargo.toml")" "0.1.4"
check "reads the [package] name"    "$(read_cargo_name "$UNITS/Cargo.toml")" "zebu-desktop"
write_cargo_version "$UNITS/Cargo.toml" 0.1.5 "$UNITS/Cargo.out.toml"
check "writes the [package] version" "$(read_cargo_version "$UNITS/Cargo.out.toml")" "0.1.5"
check "leaves a dependency's version alone" \
    "$(grep -c 'tauri = { version = "2"' "$UNITS/Cargo.out.toml")" "1"
check "leaves another section's version alone" \
    "$(grep -c '9.9.9' "$UNITS/Cargo.out.toml")" "1"

# ---------------------------------------------------------------------------
# End to end, against a throwaway repository
# ---------------------------------------------------------------------------

# make_repo <name> <version> -> path of a working clone whose origin is a bare
# repo next to it. A real npm package and a real cargo crate, both with no
# dependencies, so `npm install --package-lock-only` and `cargo check` do their
# real work offline in well under a second.
make_repo() {
    local name=$1 version=$2 dir="$TMP/$1" origin="$TMP/$1.git"
    rm -rf "$dir" "$origin"
    git init --quiet --bare "$origin"
    mkdir -p "$dir/scripts/tests" "$dir/src-tauri/src"

    cat > "$dir/package.json" <<JSON
{
    "name": "fixture-app",
    "private": true,
    "version": "$version",
    "scripts": {
        "test": "true"
    }
}
JSON

    cat > "$dir/src-tauri/tauri.conf.json" <<JSON
{
    "productName": "Fixture",
    "version": "$version",
    "plugins": {
        "updater": {
            "version": "do-not-touch"
        }
    }
}
JSON

    cat > "$dir/src-tauri/Cargo.toml" <<TOML
[package]
name = "fixture-app"
version = "$version"
edition = "2021"

[dependencies]

[package.metadata.decoy]
version = "9.9.9"

[workspace]
TOML
    echo 'fn main() {}' > "$dir/src-tauri/src/main.rs"
    echo 'target/' > "$dir/src-tauri/.gitignore"
    echo 'node_modules/' > "$dir/.gitignore"

    cp "$RELEASE" "$dir/scripts/release.sh"
    chmod +x "$dir/scripts/release.sh"

    # Lockfiles as a real repo would carry them, already at $version.
    (cd "$dir" && npm install --package-lock-only --silent >/dev/null 2>&1)
    (cd "$dir/src-tauri" && cargo generate-lockfile --quiet >/dev/null 2>&1)

    git -C "$dir" init --quiet -b main
    git -C "$dir" config user.email release-test@example.invalid
    git -C "$dir" config user.name "Release Test"
    git -C "$dir" config commit.gpgsign false
    git -C "$dir" config tag.gpgsign false
    git -C "$dir" remote add origin "$origin"
    git -C "$dir" add -A
    git -C "$dir" commit --quiet -m "fixture at $version"
    git -C "$dir" push --quiet -u origin main
    printf '%s\n' "$dir"
}

# run_release <dir> <args...> — run the fixture's copy of the script from a
# subdirectory, proving it works from anywhere in the repo. Output lands in
# $out, exit status in $rc.
run_release() {
    local dir=$1; shift
    out=$(cd "$dir/src-tauri" && ../scripts/release.sh "$@" 2>&1)
    rc=$?
}

refuses() { # name dir expected-substring args...
    local name=$1 dir=$2 want=$3; shift 3
    run_release "$dir" "$@"
    if [ "$rc" = 0 ]; then
        bad "$name (exited 0, expected a refusal)"
    elif ! printf '%s' "$out" | grep -qF "$want"; then
        bad "$name (no '$want' in: $(printf '%s' "$out" | tail -2 | tr '\n' ' '))"
    else
        ok "$name"
    fi
}

# --- a clean repo: the dry run must change absolutely nothing ---------------
repo=$(make_repo dry 0.1.4)
before=$(git -C "$repo" status --porcelain; git -C "$repo" tag; git -C "$repo" rev-parse HEAD)
run_release "$repo" --dry-run --skip-checks
after=$(git -C "$repo" status --porcelain; git -C "$repo" tag; git -C "$repo" rev-parse HEAD)
check "dry run exits 0" "$rc" "0"
check "dry run leaves the repo untouched" "$after" "$before"
if printf '%s' "$out" | grep -q '0.1.4 -> 0.1.5'; then
    ok "dry run names the version it would cut"
else
    bad "dry run names the version it would cut"
fi
if printf '%s' "$out" | grep -q 'would.*git push origin main v0.1.5'; then
    ok "dry run prints the push it would make"
else
    bad "dry run prints the push it would make"
fi
for f in package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml; do
    if printf '%s' "$out" | grep -qF "would change $f"; then
        ok "dry run lists $f"
    else
        bad "dry run lists $f"
    fi
done

# --- refusals ---------------------------------------------------------------
repo=$(make_repo dirty 0.1.4)
echo 'scratch' > "$repo/scratch.txt"
refuses "refuses a dirty tree" "$repo" "working tree is dirty" --skip-checks --dry-run

repo=$(make_repo branch 0.1.4)
git -C "$repo" checkout --quiet -b hotfix
refuses "refuses a branch that is not main" "$repo" "releases are cut from main" --skip-checks --dry-run

repo=$(make_repo tagged 0.1.4)
git -C "$repo" tag v0.1.5
refuses "refuses a tag that exists locally" "$repo" "already exists locally" --skip-checks --dry-run

repo=$(make_repo remotetag 0.1.4)
git -C "$repo" tag v0.1.5 && git -C "$repo" push --quiet origin v0.1.5 && git -C "$repo" tag -d v0.1.5 >/dev/null
refuses "refuses a tag that exists on origin" "$repo" "already exists on origin" --skip-checks --dry-run

repo=$(make_repo backwards 0.1.4)
refuses "refuses a version that goes backwards" "$repo" "is not newer than the current 0.1.4" --skip-checks --dry-run 0.1.3
refuses "refuses the current version again"     "$repo" "is not newer than the current 0.1.4" --skip-checks --dry-run 0.1.4
refuses "refuses a version that is not X.Y.Z"   "$repo" "not a version" --skip-checks --dry-run 0.2
refuses "refuses an unknown option"             "$repo" "unknown option" --skip-checks --nope

repo=$(make_repo behind 0.1.4)
# Another clone pushes a commit, so this one is behind origin/main.
git clone --quiet "$TMP/behind.git" "$TMP/behind-other"
git -C "$TMP/behind-other" config user.email release-test@example.invalid
git -C "$TMP/behind-other" config user.name "Release Test"
echo other > "$TMP/behind-other/other.txt"
git -C "$TMP/behind-other" add -A && git -C "$TMP/behind-other" commit --quiet -m other
git -C "$TMP/behind-other" push --quiet origin main
refuses "refuses a branch behind origin/main" "$repo" "behind origin/main" --skip-checks --dry-run

repo=$(make_repo mismatch 0.1.4)
# Somebody bumped one file by hand and stopped — exactly how the empty release
# happened. Say so instead of guessing which one is the truth.
sed -i.bak 's/"version": "0.1.4"/"version": "0.1.5"/' "$repo/package.json"
rm -f "$repo/package.json.bak"
git -C "$repo" commit --quiet -am "half a bump"
git -C "$repo" push --quiet origin main
refuses "refuses when the three files already disagree" "$repo" "already disagree" --skip-checks --dry-run

# --- the real thing ---------------------------------------------------------
release_and_check() { # name repo expected-version args...
    local name=$1 dir=$2 want=$3; shift 3
    run_release "$dir" "$@"
    if [ "$rc" != 0 ]; then
        bad "$name (exit $rc: $(printf '%s' "$out" | tail -3 | tr '\n' ' '))"
        return
    fi
    check "$name: package.json"      "$(read_json_version "$dir/package.json")" "$want"
    check "$name: tauri.conf.json"   "$(read_json_version "$dir/src-tauri/tauri.conf.json")" "$want"
    check "$name: Cargo.toml"        "$(read_cargo_version "$dir/src-tauri/Cargo.toml")" "$want"
    check "$name: package-lock.json" "$(read_json_version "$dir/package-lock.json")" "$want"
    check "$name: Cargo.lock" \
        "$(awk '/^name = "fixture-app"$/ { want = 1; next } want && /^version = / { print; exit }' \
            "$dir/src-tauri/Cargo.lock")" "version = \"$want\""
    check "$name: nested version untouched" \
        "$(grep -c 'do-not-touch' "$dir/src-tauri/tauri.conf.json")" "1"
    check "$name: one commit" \
        "$(git -C "$dir" log -1 --pretty=%s)" "Release $want"
    check "$name: clean tree after" "$(git -C "$dir" status --porcelain)" ""
    check "$name: tag on HEAD" \
        "$(git -C "$dir" rev-parse "v$want^{commit}")" "$(git -C "$dir" rev-parse HEAD)"
    check "$name: tag pushed" \
        "$(git -C "$dir" ls-remote --tags origin "refs/tags/v$want" | wc -l | tr -d ' ')" "1"
    check "$name: branch pushed" \
        "$(git -C "$dir" rev-parse origin/main)" "$(git -C "$dir" rev-parse HEAD)"
}

repo=$(make_repo patch 0.1.4)
release_and_check "default bump" "$repo" 0.1.5 --skip-checks

repo=$(make_repo minor 0.1.4)
release_and_check "--minor" "$repo" 0.2.0 --skip-checks --minor

repo=$(make_repo major 0.1.4)
release_and_check "--major" "$repo" 1.0.0 --skip-checks --major

repo=$(make_repo explicit 0.1.4)
release_and_check "explicit version" "$repo" 3.4.5 --skip-checks 3.4.5

# --skip-checks has to be impossible to miss in the output.
repo=$(make_repo loud 0.1.4)
run_release "$repo" --dry-run --skip-checks
if printf '%s' "$out" | grep -q 'NOT being run'; then
    ok "--skip-checks warns loudly"
else
    bad "--skip-checks warns loudly"
fi

# The gate itself: a failing `npm test` must stop the release.
repo=$(make_repo gate 0.1.4)
sed -i.bak 's/"test": "true"/"test": "false"/' "$repo/package.json"
rm -f "$repo/package.json.bak"
git -C "$repo" commit --quiet -am "a failing gate"
git -C "$repo" push --quiet origin main
run_release "$repo"
if [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'npm test failed'; then
    ok "a failing npm test stops the release"
else
    bad "a failing npm test stops the release (rc=$rc)"
fi
check "nothing was tagged after a failed gate" "$(git -C "$repo" tag)" ""
check "nothing was written after a failed gate" \
    "$(read_json_version "$repo/package.json")" "0.1.4"

echo
if [ "$fails" = 0 ]; then echo "all passed"; else echo "$fails failed"; exit 1; fi
