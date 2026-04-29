# Build stage
FROM golang:1.23-alpine AS builder

RUN apk add --no-cache gcc musl-dev

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG BUILD_SHA=dev
ARG BUILD_TIME=unknown

# Run vet + tests before building. If the custom-metric validator or any
# other package test fails, the image build fails and CI does not push.
RUN go vet ./... && CGO_ENABLED=1 go test ./...

RUN CGO_ENABLED=1 GOOS=linux go build \
  -ldflags="-s -w -X main.BuildSHA=${BUILD_SHA} -X main.BuildTime=${BUILD_TIME}" \
  -o /agent ./cmd/agent

# Runtime stage
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /agent /usr/local/bin/agent

RUN mkdir -p /app/data

ENTRYPOINT ["/usr/local/bin/agent"]
