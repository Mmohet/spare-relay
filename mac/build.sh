#!/bin/sh
set -eu
mac_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
app="${1:-$mac_root/../data/Relay Accessibility.app}"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>local.relay.accessibility</string>
  <key>CFBundleExecutable</key><string>RelayAccessibility</string>
  <key>CFBundleName</key><string>Relay Accessibility</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
swiftc -module-cache-path "$(dirname -- "$app")/swift-module-cache" "$mac_root/chat-access.swift" -o "$app/Contents/MacOS/RelayAccessibility"
codesign --force --sign - "$app"
printf '%s\n' "$app"
