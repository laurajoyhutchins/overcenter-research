ARG GO_VERSION
ARG NODE_VERSION
FROM golang:${GO_VERSION}-bookworm AS build
WORKDIR /src
COPY executor ./executor
RUN cd executor && go build -o /out/overcenter-executor ./cmd/overcenter-executor

FROM node:${NODE_VERSION}-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/overcenter-executor /usr/local/bin/overcenter-executor
ENTRYPOINT ["/usr/local/bin/overcenter-executor"]
