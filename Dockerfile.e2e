# E2E UI-test image: Playwright's official image plus a full ffmpeg (the
# bundled one only encodes VP8) and pnpm (the README quick-setup flow runs
# `pnpm run setup:feishu` inside this image).
#
# Build once:  docker build -f Dockerfile.e2e -t dsh-e2e-tools .
# The launcher (`pnpm run e2e:ui`) builds it automatically when missing.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

RUN apt-get update -qq \
    && apt-get install -y -qq ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm
