#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "========================================="
echo "  NPM Commander (Tauri) - macOS Builder"
echo "========================================="
echo ""

# Exit on any error
set -e

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "📦 Installing npm dependencies..."
  npm install
  echo ""
fi

# Check if Rust is installed
if ! command -v cargo &> /dev/null; then
  echo "❌ Rust is not installed. Please install it from https://rustup.rs"
  exit 1
fi

echo "🧹 Cleaning up previous DMG artifacts..."
rm -rf src-tauri/target/release/bundle/dmg || true

echo "🔨 Building macOS app with Tauri..."
# Ensure we have a clean frontend build
npm run build

echo "🚀 Packaging application..."
npm run tauri build

# Check for the built app
APP_PATH="src-tauri/target/release/bundle/macos/NPM Commander.app"
if [ -d "$APP_PATH" ]; then
  echo ""
  echo "========================================="
  echo "✅ BUILD SUCCESSFUL!"
  echo "========================================="
  echo ""
  echo "📂 App location: $APP_PATH"
  
  DMG_PATH=$(find src-tauri/target/release/bundle/dmg -name "*.dmg" | head -n 1)
  if [ -f "$DMG_PATH" ]; then
    echo "📦 Installer: $DMG_PATH"
  else
    echo "⚠️  Note: DMG installer was not generated, but the .app is ready."
  fi
  
  echo ""
  echo "💡 Note: The folder is large because of build artifacts in src-tauri/target."
  echo "   You can run 'cargo clean' inside src-tauri if you want to recover space."
  echo ""
  echo "Opening Finder..."
  open "src-tauri/target/release/bundle/macos"
else
  echo ""
  echo "❌ Build failed. Please review the errors above."
  exit 1
fi
