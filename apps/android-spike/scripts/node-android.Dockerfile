# EXPERIMENTAL (Android spike). Cross-compiles upstream Node.js for Android on a Linux x86_64 host,
# which is what Node's android-configure supports (on a macOS host, gyp builds the host tools with
# OS=android and fails). On Apple Silicon this runs under amd64 emulation and takes a while.
#
#   docker build --platform linux/amd64 -f node-android.Dockerfile \
#     --build-arg NODE_VERSION=24.13.0 --build-arg ARCH=arm64 -o out .
FROM --platform=linux/amd64 debian:bookworm
ARG NODE_VERSION=24.13.0
ARG NDK_VERSION=r28c
ARG ARCH=arm64
ARG API=24
ARG JOBS=6
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 curl ca-certificates xz-utils unzip git patch \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSLo ndk.zip https://dl.google.com/android/repository/android-ndk-${NDK_VERSION}-linux.zip \
    && unzip -q ndk.zip && rm ndk.zip && mv android-ndk-${NDK_VERSION} ndk
RUN curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}.tar.xz \
    && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt | grep " node-v${NODE_VERSION}.tar.xz\$" | sha256sum -c \
    && tar xf node-v${NODE_VERSION}.tar.xz && rm node-v${NODE_VERSION}.tar.xz
WORKDIR /build/node-v${NODE_VERSION}
RUN case ${ARCH} in arm64) CPU=arm64 T=aarch64-linux-android A=arm64;; x86_64) CPU=x64 T=x86_64-linux-android A=x64;; esac \
    && TC=/build/ndk/toolchains/llvm/prebuilt/linux-x86_64 \
    && export PATH="$PATH:$TC/bin" CC=$TC/bin/$T${API}-clang CXX=$TC/bin/$T${API}-clang++ \
    && export GYP_DEFINES="target_arch=$A v8_target_arch=$A android_target_arch=$A host_os=linux OS=android android_ndk_path=/build/ndk" \
    && ./configure --dest-cpu=$CPU --dest-os=android --openssl-no-asm --cross-compiling --with-intl=small-icu \
    && make -j${JOBS} \
    && mkdir -p /out && $TC/bin/llvm-strip -o /out/node out/Release/node \
    && cp $TC/sysroot/usr/lib/$T/libc++_shared.so /out/ \
    && ls -l /out
FROM scratch
COPY --from=0 /out/ /
