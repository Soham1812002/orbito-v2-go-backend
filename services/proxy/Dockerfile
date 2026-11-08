# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS log-build
WORKDIR /log-src
COPY utils/logging/ ./
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /logrunner .

FROM nginx:1.28-alpine
COPY --from=log-build /logrunner /usr/local/bin/logrunner
COPY services/proxy/nginx.conf /etc/nginx/nginx.conf
ENTRYPOINT ["/usr/local/bin/logrunner", "/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
