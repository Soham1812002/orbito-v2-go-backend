# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS log-build
ENV GOMAXPROCS=2
WORKDIR /log-src
COPY utils/logging/ ./
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /logrunner .

FROM golang:1.27-alpine AS build
ENV GOMAXPROCS=2
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY services/gateway/go.mod ./
COPY services/gateway/ ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go test ./... && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /gateway ./cmd/gateway && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /spoolctl ./cmd/spoolctl
RUN mkdir /spool && chown 10001:10001 /spool

FROM scratch
COPY --from=log-build /logrunner /logrunner
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /gateway /gateway
COPY --from=build /spoolctl /spoolctl
COPY --from=build --chown=10001:10001 /spool /spool
USER 10001:10001
ENV SPOOL_DIR=/spool
EXPOSE 5001 5002 8081
HEALTHCHECK --interval=15s --timeout=4s --start-period=15s --retries=3 CMD ["/gateway", "healthcheck"]
ENTRYPOINT ["/logrunner", "/gateway"]
