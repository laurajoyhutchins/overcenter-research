FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY executor ./executor
RUN cd executor && go build -o /out/overcenter-executor ./cmd/overcenter-executor

FROM node:22.16.0-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/overcenter-executor /usr/local/bin/overcenter-executor
ENTRYPOINT ["/usr/local/bin/overcenter-executor"]
