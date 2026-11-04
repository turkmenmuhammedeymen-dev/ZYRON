#!/usr/bin/env bash
# memcore'u Android NDK ile derleyip APK'ya girecek yere koyar:
#   app/src/main/jniLibs/<abi>/libmemcore.so   (aslinda calistirilabilir bir ELF)
# Gereken: ANDROID_NDK_HOME (veya ANDROID_NDK_ROOT / ANDROID_NDK_LATEST_HOME) ayarli olmali.
set -euo pipefail

NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${ANDROID_NDK_LATEST_HOME:-}}}"
if [ -z "$NDK" ] || [ ! -d "$NDK" ]; then
  echo "Android NDK bulunamadi. ANDROID_NDK_HOME degiskenini NDK klasorune ayarla." >&2
  exit 1
fi
case "$(uname -s)" in
  Linux)  HOST=linux-x86_64 ;;
  Darwin) HOST=darwin-x86_64 ;;
  *) echo "Desteklenmeyen derleme makinesi: $(uname -s)" >&2; exit 1 ;;
esac
BIN="$NDK/toolchains/llvm/prebuilt/$HOST/bin"
API=23
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

build() {  # build <abi> <triple>
  local abi="$1" tri="$2" out="$ROOT/app/src/main/jniLibs/$1"
  mkdir -p "$out"
  "$BIN/${tri}${API}-clang" -O2 -fPIE -pie -s -Wall \
    -Wl,-z,max-page-size=16384 \
    -o "$out/libmemcore.so" "$HERE/memcore.c"
  echo "OK  $abi -> $out/libmemcore.so"
  "$BIN/${tri}${API}-clang" -O2 -fPIE -pie -s -Wall \
    -Wl,-z,max-page-size=16384 \
    -o "$out/libpractice.so" "$HERE/practice.c"
  echo "OK  $abi -> $out/libpractice.so"
}

build arm64-v8a   aarch64-linux-android
build armeabi-v7a armv7a-linux-androideabi
build x86_64      x86_64-linux-android
