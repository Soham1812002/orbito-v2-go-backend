FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -o /gateway ./cmd/gateway
FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --create-home gateway && mkdir /spool && chown gateway:gateway /spool
COPY --from=build /gateway /usr/local/bin/gateway
USER gateway
ENV SPOOL_DIR=/spool
EXPOSE 5001 5002 8081
ENTRYPOINT ["gateway"]
