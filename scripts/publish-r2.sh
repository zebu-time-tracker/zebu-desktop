#!/usr/bin/env bash
# Publishes a built release to the Cloudflare R2 bucket the updater and the
# downloads page read (https://app-downloads.zebu.work), and verifies it by
# reading it back.
#
#   scripts/publish-r2.sh publish \
#       --bucket app-downloads --base desktop --version 0.2.0 \
#       --dir upload --manifest latest.json --aliases aliases.tsv \
#       --public-base https://app-downloads.zebu.work [--print-plan]
#
# ---------------------------------------------------------------------------
# Ordering is the whole point
# ---------------------------------------------------------------------------
# The plan is executed strictly in three phases:
#
#   1. `<base>/<version>/…`   every built artifact beside its `.sig`
#   2. `<base>/latest/…`      the stable names a download page links to
#   3. `<base>/latest.json`   the updater manifest, LAST
#
# An installed copy must never learn about a version before its files are
# there, so the manifest goes up only once everything it names is uploaded.
# The manifest itself only ever names phase-1 URLs (enforced in
# scripts/updater-manifest.mjs): the updater verifies a minisign signature
# against the exact bytes it downloads, so an alias caught mid-overwrite
# would fail as a signature error, not as a 404.
#
# ---------------------------------------------------------------------------
# Dry runs
# ---------------------------------------------------------------------------
# A dry run is the same code, the same credentials and the same ordering with
# `--base desktop/_dryrun/<run id>` instead of `--base desktop`. One variable
# is the only difference, so the rehearsal exercises the route the real thing
# takes, and a dry run can never write `desktop/latest.json`,
# `desktop/latest/*` or a real version folder.
#
# ---------------------------------------------------------------------------
# This script never deletes anything
# ---------------------------------------------------------------------------
# There is no delete, no `s3 rm`, and no `s3 sync` (which mirrors, and would
# remove real releases to match a source directory). Uploads are individual
# `s3api put-object` calls. Scratch objects under `desktop/_dryrun/` are left
# for a bucket lifecycle rule to expire; a workflow that cannot delete cannot
# delete the wrong thing however wrong its variables get.
#
# ---------------------------------------------------------------------------
# Never printed
# ---------------------------------------------------------------------------
# The R2 endpoint carries the account id. It is passed to the AWS CLI through
# AWS_ENDPOINT_URL in the environment and never appears on a command line, in
# the plan, or in a log line here. No `set -x` in this file.
#
# `AWS_BIN`/`CURL_BIN`/`NODE_BIN` exist so scripts/tests/publish-r2.test.sh
# can run the real logic against recording stand-ins; they default to the
# real tools.
set -u

AWS_BIN=${AWS_BIN:-aws}
CURL_BIN=${CURL_BIN:-curl}
NODE_BIN=${NODE_BIN:-node}

die() { printf 'publish-r2: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

bucket=''
base=''
version=''
dir=''
manifest=''
aliases=''
public_base=''
print_plan=false

parse_args() {
    while [ $# -gt 0 ]; do
        case $1 in
            --bucket)      [ $# -ge 2 ] || die "--bucket needs a value"; bucket=$2; shift 2 ;;
            --base)        [ $# -ge 2 ] || die "--base needs a value"; base=$2; shift 2 ;;
            --version)     [ $# -ge 2 ] || die "--version needs a value"; version=$2; shift 2 ;;
            --dir)         [ $# -ge 2 ] || die "--dir needs a value"; dir=$2; shift 2 ;;
            --manifest)    [ $# -ge 2 ] || die "--manifest needs a value"; manifest=$2; shift 2 ;;
            --aliases)     [ $# -ge 2 ] || die "--aliases needs a value"; aliases=$2; shift 2 ;;
            --public-base) [ $# -ge 2 ] || die "--public-base needs a value"; public_base=$2; shift 2 ;;
            --print-plan)  print_plan=true; shift ;;
            *) die "unknown option '$1'" ;;
        esac
    done
}

# --- content types and caching ---------------------------------------------

content_type_for() {
    case $1 in
        *.json)      printf 'application/json' ;;
        *.sig)       printf 'text/plain' ;;
        *.dmg)       printf 'application/x-apple-diskimage' ;;
        *.exe)       printf 'application/vnd.microsoft.portable-executable' ;;
        *.msi)       printf 'application/x-msi' ;;
        *.AppImage)  printf 'application/x-executable' ;;
        *.tar.gz)    printf 'application/gzip' ;;
        *.deb)       printf 'application/vnd.debian.binary-package' ;;
        *.rpm)       printf 'application/x-rpm' ;;
        *)           printf 'application/octet-stream' ;;
    esac
}

# Versioned keys are written once and never again, so they may be cached
# forever. The aliases move every release, and the manifest is polled by every
# install on every launch — it must revalidate or a new version stays
# invisible behind Cloudflare's cache for as long as it is fresh.
cache_control_for_phase() {
    case $1 in
        versioned) printf 'public, max-age=31536000, immutable' ;;
        alias)     printf 'public, max-age=300' ;;
        manifest)  printf 'no-cache' ;;
    esac
}

# --- the plan ---------------------------------------------------------------

# Emits `phase<TAB>key<TAB>local file` lines, in the order they must be
# uploaded. Building it as data (rather than uploading as we walk) is what
# lets --print-plan and the tests see exactly what a run would write.
build_plan() {
    local f name
    for f in "$dir"/*; do
        [ -f "$f" ] || continue
        name=$(basename -- "$f")
        printf 'versioned\t%s/%s/%s\t%s\n' "$base" "$version" "$name" "$f"
    done | sort -t'	' -k2,2

    if [ -n "$aliases" ]; then
        while IFS=$'\t' read -r alias_name source_name; do
            [ -n "${alias_name:-}" ] || continue
            [ -f "$dir/$source_name" ] || die "alias $alias_name names $source_name, which is not in $dir"
            printf 'alias\t%s/latest/%s\t%s\n' "$base" "$alias_name" "$dir/$source_name"
        done < "$aliases"
    fi

    printf 'manifest\t%s/latest.json\t%s\n' "$base" "$manifest"
}

# --- publish ----------------------------------------------------------------

upload_one() { # phase key file
    local phase=$1 key=$2 file=$3
    "$AWS_BIN" s3api put-object \
        --bucket "$bucket" \
        --key "$key" \
        --body "$file" \
        --content-type "$(content_type_for "$key")" \
        --cache-control "$(cache_control_for_phase "$phase")" \
        --output text --query ETag >/dev/null \
        || die "upload failed: $key"
}

# Read back what we just wrote, from the API. A wrong prefix, a truncated
# upload or a credential scoped to the wrong bucket all show up here.
verify_object() { # key file
    local key=$1 file=$2 remote local_size
    remote=$("$AWS_BIN" s3api head-object --bucket "$bucket" --key "$key" --output text --query ContentLength 2>/dev/null) \
        || die "verify: $key is not in the bucket after upload"
    local_size=$(wc -c < "$file" | tr -d ' ')
    [ "$remote" = "$local_size" ] || die "verify: $key is $remote bytes in the bucket, $local_size locally"
    note "  ok  $key ($local_size bytes)"
}

# Fetch the manifest over the public hostname and HEAD every URL in it. This
# is the check that catches a wrong prefix or a bucket that is not actually
# public — the two failures the API-side check cannot see.
verify_public() {
    [ -n "$public_base" ] || return 0
    local body urls url
    # The query string is part of Cloudflare's cache key, so this always
    # reaches the object we just wrote rather than a cached predecessor.
    body=$("$CURL_BIN" -fsS --max-time 30 "$public_base/$base/latest.json?_=$$") \
        || die "verify: cannot fetch $public_base/$base/latest.json"

    # shellcheck disable=SC2016  # the JS below is deliberately unexpanded
    urls=$(printf '%s' "$body" | "$NODE_BIN" -e '
        let raw = "";
        process.stdin.on("data", (c) => { raw += c; });
        process.stdin.on("end", () => {
            const m = JSON.parse(raw);
            if (!m.version || !m.platforms || Object.keys(m.platforms).length === 0) {
                console.error("manifest has no version/platforms");
                process.exit(1);
            }
            for (const [target, p] of Object.entries(m.platforms)) {
                if (!p.signature || !p.url) { console.error(`${target} is incomplete`); process.exit(1); }
                console.log(p.url);
            }
        });
    ') || die "verify: the published manifest is not a usable updater manifest"

    while IFS= read -r url; do
        [ -n "$url" ] || continue
        "$CURL_BIN" -fsS -I --max-time 30 "$url" >/dev/null || die "verify: $url in the manifest does not resolve"
        note "  ok  $url"
    done <<EOF
$urls
EOF
}

cmd_publish() {
    [ -n "$bucket" ] || die "--bucket is required"
    [ -n "$version" ] || die "--version is required"
    [ -n "$dir" ] || die "--dir is required"
    [ -n "$manifest" ] || die "--manifest is required"
    [ -d "$dir" ] || die "--dir '$dir' is not a directory"
    [ -f "$manifest" ] || die "--manifest '$manifest' does not exist"
    # Only two destinations exist. Anything else — including an empty or
    # half-built prefix, which is why this is a whole-string match and not a
    # prefix test — is refused before a single object is written.
    case $base in
        desktop|desktop/_dryrun/?*) ;;
        *) die "--base '${base}' is neither 'desktop' nor 'desktop/_dryrun/<run id>'" ;;
    esac

    local plan
    plan=$(build_plan) || exit 1

    if [ "$print_plan" = true ]; then
        printf '%s\n' "$plan"
        return 0
    fi

    [ -n "${AWS_ENDPOINT_URL:-}" ] || die "AWS_ENDPOINT_URL is not set (the R2 endpoint)"

    local phase key file last_phase=''
    while IFS=$'\t' read -r phase key file; do
        [ -n "${phase:-}" ] || continue
        if [ "$phase" != "$last_phase" ]; then
            note "-- $phase"
            last_phase=$phase
        fi
        upload_one "$phase" "$key" "$file"
        note "  put $key"
    done <<EOF
$plan
EOF

    note "-- verifying"
    while IFS=$'\t' read -r phase key file; do
        [ -n "${phase:-}" ] || continue
        verify_object "$key" "$file"
    done <<EOF
$plan
EOF
    verify_public
    note "published $version to $base"
}

main() {
    [ $# -ge 1 ] || die "usage: publish-r2.sh publish [options]"
    local command=$1; shift
    parse_args "$@"
    case $command in
        publish) cmd_publish ;;
        *) die "unknown command '$command'" ;;
    esac
}

# Sourcing this file (as the tests do) defines the helpers without running
# anything; executing it runs main.
case ${0##*/} in
    publish-r2.sh) main "$@" ;;
esac
