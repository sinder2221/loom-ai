#!/bin/sh
set -eu

cd "$(dirname "$0")"
release=target/release
output="$release/bundle/macos"
if [ ! -x "$release/loom-desktop" ]; then
  echo 'Prepare the desktop assets and build the Cargo release binary before bundling.' >&2
  exit 1
fi

mkdir -p "$output"
staging=$(mktemp -d "$output/.loom.XXXXXX")
trap 'rm -rf "$staging"' EXIT
bundle="$staging/Loom.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
cp Info.plist "$bundle/Contents/Info.plist"
cp icons/icon.icns "$bundle/Contents/Resources/icon.icns"
cp "$release/loom-desktop" "$bundle/Contents/MacOS/loom-desktop"
runtime="$bundle/Contents/Resources/usage-runtime/bridge"
mkdir -p "$runtime/usage/local" "$runtime/usage/sources" "$runtime/helper" "$runtime/src"
cp ../bridge/usage/*.ts "$runtime/usage/"
cp ../bridge/usage/local/*.ts "$runtime/usage/local/"
cp ../bridge/usage/sources/*.ts "$runtime/usage/sources/"
cp ../bridge/helper/files.ts "$runtime/helper/"
cp ../bridge/src/approval-input.ts "$runtime/src/"
codesign --force --sign - "$bundle"
codesign --verify --strict "$bundle"

rm -rf "$output/Loom.app"
mv "$bundle" "$output/Loom.app"
printf '%s\n' "${PWD}/$output/Loom.app"
