# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS log-build
WORKDIR /log-src
COPY utils/logging/ ./
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /logrunner .

FROM postgis/postgis:16-3.5
COPY --from=log-build /logrunner /usr/local/bin/logrunner
ENTRYPOINT ["/usr/local/bin/logrunner", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["postgres", "-c", "log_min_error_statement=panic", "-c", "log_parameter_max_length_on_error=0", "-c", "log_error_verbosity=terse"]
