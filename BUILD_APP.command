#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "========================================="
echo "  NPM Commander - macOS App Builder"
echo "========================================="
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
  echo ""
fi

echo "🔨 Building macOS app..."
npm run build

if [ -d "dist/mac/NPM Commander.app" ] || [ -d "dist/mac-arm64/NPM Commander.app" ]; then
  echo ""
  echo "✅ Build successful!"
  echo ""
  
  if [ -d "dist/mac-arm64/NPM Commander.app" ]; then
    echo "📂 App location: dist/mac-arm64/NPM Commander.app"
    echo ""
    echo "Opening Finder..."
    open "dist/mac-arm64"
  else
    echo "📂 App location: dist/mac/NPM Commander.app"
    echo ""
    echo "Opening Finder..."
    open "dist/mac"
  fi
else
  echo ""
  echo "❌ Build failed. Check the output above for errors."
fi
