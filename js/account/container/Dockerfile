FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS cliproxy-builder

ARG TARGETOS
ARG TARGETARCH
RUN apk add --no-cache git
WORKDIR /src
RUN git init && git remote add origin https://github.com/router-for-me/CLIProxyAPI.git \
  && git fetch --depth 1 origin 673131f57484517c3a1eae7e36c4cfa7b9bb4efc \
  && git checkout --detach FETCH_HEAD
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -buildvcs=false -ldflags="-s -w" -o /cliproxyapi ./cmd/server

FROM node:22-alpine

RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY relay.mjs /app/relay.mjs
COPY cliproxy.config.yaml /app/cliproxy.config.yaml
COPY --from=cliproxy-builder /cliproxyapi /app/cliproxyapi

ENV PORT=8080
EXPOSE 8080
USER node

CMD ["node", "/app/relay.mjs"]
