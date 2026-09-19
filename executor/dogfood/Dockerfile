ARG GO_IMAGE
ARG NODE_IMAGE
ARG GO_VERSION
ARG NODE_VERSION
FROM ${GO_IMAGE} AS build
ARG GO_VERSION
RUN test "$(go env GOVERSION)" = "go${GO_VERSION}"
WORKDIR /src
COPY executor ./executor
RUN cd executor && go build -o /out/overcenter-executor ./cmd/overcenter-executor

FROM ${NODE_IMAGE}
ARG NODE_VERSION
RUN test "$(node --version)" = "v${NODE_VERSION}" && git --version >/dev/null
COPY --from=build /out/overcenter-executor /usr/local/bin/overcenter-executor
ENTRYPOINT ["/usr/local/bin/overcenter-executor"]
