#!/bin/sh
# Builds the Proton Mail Bridge core as one fully static binary, so the
# extension ships it and needs nothing installed (works on glibc and musl).
#
#   bridge/build.sh OUTPUT [CACHE_DIR]
#
# Downloads a checksum-verified Go toolchain and the pinned Bridge release,
# applies static-build.patch (drops the libfido2 and libsecret cgo
# dependencies; the keyring is still used, over D-Bus) and links statically.
# Needs gcc, git, curl and a static libc (libc.a).
set -eu

BRIDGE_TAG=v3.27.1
GO_VERSION=1.26.7
GO_SHA256_arm64=5a4ec883379d51ee9ce1040d5e87f8d35e20387574dd8c947feb01eabc3c1b37
GO_SHA256_amd64=ffb5f8de10c62550dfddab66b36b57030721e0a44a3218e9e1181d7b59f121ca

here=$(realpath "$(dirname "$0")")
out=$(realpath -m "$1")
cache=$(realpath -m "${2:-$here/../.build}")

case $(uname -m) in
aarch64|arm64) arch=arm64; sum=$GO_SHA256_arm64 ;;
x86_64|amd64) arch=amd64; sum=$GO_SHA256_amd64 ;;
*) echo "build.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$cache"
cd "$cache"

if [ "$(cat go/VERSION 2>/dev/null | head -1)" != "go$GO_VERSION" ]; then
    tarball=go$GO_VERSION.linux-$arch.tar.gz
    curl -fsSL -o "$tarball" "https://go.dev/dl/$tarball"
    echo "$sum  $tarball" | sha256sum -c --quiet
    rm -rf go
    tar xzf "$tarball"
    rm "$tarball"
fi

rm -rf src
git -c advice.detachedHead=false clone -q --depth 1 --branch "$BRIDGE_TAG" \
    https://github.com/ProtonMail/proton-bridge src
cd src
git apply "$here/static-build.patch"

export PATH="$cache/go/bin:$PATH" GOTOOLCHAIN=local GOFLAGS=-modcacherw \
    GOPATH="$cache/gopath" GOCACHE="$cache/gocache" CGO_ENABLED=1
(cd utils && ./credits.sh bridge) 2>/dev/null

c=github.com/ProtonMail/proton-bridge/v3/internal/constants
mkdir -p "$(dirname "$out")"
rm -f "$out"
go build -trimpath \
    -tags 'nofido nolibsecret netgo osusergo sqlite_omit_load_extension' \
    -ldflags "-s -w -linkmode external -extldflags -static
        -X $c.Version=${BRIDGE_TAG#v} -X $c.Tag=$BRIDGE_TAG -X $c.BuildEnv=prod
        -X '$c.FullAppName=Proton Mail Bridge'" \
    -o "$out" ./cmd/Desktop-Bridge 2>&1 | { grep -v 'statically linked' || true; }
[ -x "$out" ]
echo "Built $out (Proton Mail Bridge $BRIDGE_TAG)"
