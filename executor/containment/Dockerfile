ARG GO_VERSION
ARG NODE_VERSION
FROM golang:${GO_VERSION}-bookworm AS build
WORKDIR /src
COPY executor ./executor
RUN cd executor && go build -o /out/overcenter-executor ./cmd/overcenter-executor

FROM node:${NODE_VERSION}-bookworm-slim
COPY --from=build /out/overcenter-executor /usr/local/bin/overcenter-executor
COPY test/fixtures/computation-child.mjs /fixture.mjs
COPY executor/containment/driver.mjs /driver.mjs
ENTRYPOINT ["node","/driver.mjs"]
