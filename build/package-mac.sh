#!/usr/bin/env bash
#
# Build a shareable macOS app + .dmg for Nova.
#
# electron-builder can't notarize (that needs a paid Apple Developer ID) and, with
# no Developer ID present, it *skips* code signing — which leaves the renamed bundle
# with a broken signature that macOS refuses to launch. So we build the unpacked
# .app, ad-hoc sign it ourselves (enough to run after the user clears quarantine),
# then assemble the .dmg by hand.
#
# Usage:  bash build/package-mac.sh [arm64|universal]   (default: universal)
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${1:-universal}"
VERSION="$(node -p "require('./package.json').version")"
case "$ARCH" in
  arm64)     APPDIR="dist/mac-arm64";     SUFFIX="arm64" ;;
  universal) APPDIR="dist/mac-universal"; SUFFIX="universal" ;;
  *) echo "Unknown arch '$ARCH' (use arm64 or universal)"; exit 1 ;;
esac
APP="$APPDIR/Nova.app"
DMG="dist/Nova-${VERSION}-${SUFFIX}.dmg"

echo "▸ Building unpacked app bundle ($ARCH)…"
npx electron-builder --mac dir --"$ARCH"

echo "▸ Ad-hoc signing the bundle…"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "▸ Assembling DMG…"
STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/Nova.app"          # ditto preserves the code signature
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Nova ${VERSION}" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

echo "✓ Done → $DMG ($(du -h "$DMG" | cut -f1))"
