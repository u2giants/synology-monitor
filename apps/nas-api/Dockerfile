# Build stage — Alpine is fine for compiling static Go binary
FROM golang:1.23-alpine AS builder

WORKDIR /build
COPY go.mod ./
COPY . .

ARG BUILD_SHA=dev
ARG BUILD_TIME=unknown
RUN CGO_ENABLED=0 GOOS=linux go build \
  -ldflags="-s -w -X main.BuildSHA=${BUILD_SHA} -X main.BuildTime=${BUILD_TIME}" \
  -o /nas-api ./cmd/server

# Runtime stage — Debian/glibc required to dlopen Synology's glibc binaries
# (synopkg, synoacltool, synoshare link against glibc symbols absent in musl)
FROM debian:12-slim

# Docker CE CLI + compose plugin from Docker's official repo
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg \
     | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && chmod a+r /etc/apt/keyrings/docker.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
     https://download.docker.com/linux/debian bookworm stable" \
     > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends \
    btrfs-progs \
    coreutils \
    dnsutils \
    docker-ce-cli \
    docker-compose-plugin \
    e2fsprogs \
    findutils \
    grep \
    iproute2 \
    lsof \
    procps \
    smartmontools \
    sqlite3 \
    tzdata \
    util-linux \
    wget \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=builder /nas-api /usr/local/bin/nas-api

ENTRYPOINT ["/usr/local/bin/nas-api"]
