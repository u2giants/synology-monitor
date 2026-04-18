# Build stage
FROM golang:1.23-alpine AS builder

WORKDIR /build
COPY go.mod ./
COPY . .

ARG BUILD_SHA=dev
ARG BUILD_TIME=unknown
RUN CGO_ENABLED=0 GOOS=linux go build \
  -ldflags="-s -w -X main.BuildSHA=${BUILD_SHA} -X main.BuildTime=${BUILD_TIME}" \
  -o /nas-api ./cmd/server

# Runtime stage — needs bash because executor runs /bin/bash -c
FROM alpine:3.20

RUN apk add --no-cache \
  bash \
  bind-tools \
  btrfs-progs \
  ca-certificates \
  coreutils \
  docker-cli \
  docker-cli-compose \
  e2fsprogs \
  findutils \
  grep \
  iproute2 \
  lsof \
  procps \
  smartmontools \
  sqlite \
  tzdata \
  util-linux

COPY --from=builder /nas-api /usr/local/bin/nas-api

ENTRYPOINT ["/usr/local/bin/nas-api"]
