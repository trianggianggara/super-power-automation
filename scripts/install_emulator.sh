#!/usr/bin/env bash
set -e

SDK_DIR="/home/nbs59/android-sdk"
mkdir -p "$SDK_DIR"

echo "=== Downloading Android Command Line Tools ==="
ZIP_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
ZIP_FILE="/tmp/cmdline-tools.zip"

curl -L "$ZIP_URL" -o "$ZIP_FILE"

echo "=== Extracting Command Line Tools ==="
# SDK manager expects cmdline-tools/latest/bin/...
mkdir -p "$SDK_DIR/cmdline-tools"
unzip -q "$ZIP_FILE" -d "$SDK_DIR/cmdline-tools-temp"

mv "$SDK_DIR/cmdline-tools-temp/cmdline-tools" "$SDK_DIR/cmdline-tools/latest"
rm -rf "$SDK_DIR/cmdline-tools-temp"
rm -f "$ZIP_FILE"

echo "=== Accepting Licenses ==="
yes | "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK_DIR" --licenses

echo "=== Installing Android SDK components (Platform-Tools, Emulator, Android 14 Image) ==="
"$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK_DIR" \
    "platform-tools" \
    "emulator" \
    "system-images;android-34;google_apis;x86_64"

echo "=== Creating AVD (pixel10) ==="
echo "no" | "$SDK_DIR/cmdline-tools/latest/bin/avdmanager" --sdk_root="$SDK_DIR" \
    create avd \
    -n pixel10 \
    -k "system-images;android-34;google_apis;x86_64" \
    --force

echo "=== Cloning rootAVD ==="
rm -rf /home/nbs59/autoregister-account/rootAVD
git clone https://github.com/newbit1/rootAVD.git /home/nbs59/autoregister-account/rootAVD

echo "=== Setup Completed Successfully ==="
echo "You can start the emulator with: $SDK_DIR/emulator/emulator -avd pixel10"
