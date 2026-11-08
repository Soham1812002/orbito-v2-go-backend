# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod ./
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go test ./... && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /gateway ./cmd/gateway
RUN mkdir /spool && chown 10001:10001 /spool

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /gateway /gateway
COPY --from=build --chown=10001:10001 /spool /spool
USER 10001:10001
ENV SPOOL_DIR=/spool
EXPOSE 5001 5002 8081
ENTRYPOINT ["/gateway"]
