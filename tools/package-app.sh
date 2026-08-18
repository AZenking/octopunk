#!/bin/bash
# Assemble a standalone OctoPunk.app from the local Electron runtime —
# offline replacement for electron-builder (no network access needed).
#
# Layout produced:
#   release/OctoPunk.app
#     Contents/MacOS/OctoPunk                  (renamed Electron binary)
#     Contents/Resources/app/                  (payload)
#       dist-electron/electron/main.js        (esbuild bundle: electron+ TS, MCP SDK inlined)
#       electron/resources/{icon.icns,icon-dock.png}  (main.ts resolves via __dirname/../../)
#       dist/                                  (vite renderer, built by build:ui)
#       node_modules/{better-sqlite3,bindings} (native module stays external)
#
# Requires: node_modules/electron (dist bundle), vite's esbuild, a prior
# `npm run build:ui` (invoked below) so dist/ is fresh.

set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="OctoPunk"
BUNDLE_ID="com.octopunk.desktop"
VERSION="$(node -p "require('./package.json').version")"
APP="release/${APP_NAME}.app"
STAGE="release/staging-app"
ELECTRON_APP="node_modules/electron/dist/Electron.app"
ESBUILD="$(ls node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -1)"

echo "==> Renderer (vite)"
npm run build:ui >/dev/null

echo "==> Main process (esbuild bundle, externals: electron, better-sqlite3)"
rm -rf "$STAGE"
mkdir -p "$STAGE/app/dist-electron/electron" "$STAGE/app/electron/resources"
cp -R dist "$STAGE/app/dist"
# main.ts references the preload via __dirname, so it must land beside it.
"$ESBUILD" electron/main.ts electron/preload.ts \
  --bundle --platform=node --format=cjs --target=ES2022 \
  --external:electron --external:better-sqlite3 \
  --outbase=electron --outdir="$STAGE/app/dist-electron/electron"

cp electron/resources/icon.icns electron/resources/icon-dock.png "$STAGE/app/electron/resources/"

cat > "$STAGE/app/package.json" <<EOF
{
  "name": "octopunk",
  "productName": "$APP_NAME",
  "version": "$VERSION",
  "main": "dist-electron/electron/main.js",
  "private": true
}
EOF

# Runtime-native dependency only; everything else was inlined by esbuild.
# bindings → file-uri-to-path is its full runtime closure.
mkdir -p "$STAGE/app/node_modules"
cp -RL node_modules/better-sqlite3 "$STAGE/app/node_modules/better-sqlite3"
cp -RL node_modules/bindings "$STAGE/app/node_modules/bindings"
cp -RL node_modules/file-uri-to-path "$STAGE/app/node_modules/file-uri-to-path"
# Drop macOS fried egg-layer junk pnpm may have carried over.
find "$STAGE/app/node_modules" -name ".bin" -type d -prune -exec rm -rf {} + 2>/dev/null || true

echo "==> Copying Electron runtime"
rm -rf "$APP"
mkdir -p release
cp -R "$ELECTRON_APP" "$APP"

echo "==> Renaming bundle"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$APP_NAME"

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile $APP_NAME" "$PLIST"
cp electron/resources/icon.icns "$APP/Contents/Resources/${APP_NAME}.icns"

# Chromium derives helper bundle names from the app name; rename all four.
for kind in "" " (GPU)" " (Renderer)" " (Plugin)"; do
  src="Electron Helper${kind}"
  dst="${APP_NAME} Helper${kind}"
  dir="$APP/Contents/Frameworks/${src}.app"
  [ -d "$dir" ] || continue
  mv "$dir" "$APP/Contents/Frameworks/${dst}.app"
  mv "$APP/Contents/Frameworks/${dst}.app/Contents/MacOS/$src" \
     "$APP/Contents/Frameworks/${dst}.app/Contents/MacOS/$dst"
  hp="$APP/Contents/Frameworks/${dst}.app/Contents/Info.plist"
  # Helper plists carry no CFBundleExecutable — macOS falls back to
  # CFBundleName, so renaming the binary + updating the name is enough.
  /usr/libexec/PlistBuddy -c "Set :CFBundleName $dst" "$hp"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${BUNDLE_ID}.helper$(echo "$kind" | tr -d ' ()' | tr 'A-Z' 'a-z' | sed 's/gpu/-gpu/;s/renderer/-renderer/;s/plugin/-plugin/')" "$hp"
done

echo "==> Installing payload"
rm -rf "$APP/Contents/Resources/app"
mv "$STAGE/app" "$APP/Contents/Resources/app"
rmdir "$STAGE" 2>/dev/null || true

echo "==> Ad-hoc codesign (required to launch on Apple Silicon)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
codesign --verify --deep "$APP"

echo "==> Done: $APP"
du -sh "$APP"
