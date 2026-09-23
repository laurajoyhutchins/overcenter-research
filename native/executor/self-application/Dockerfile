ARG NODE_IMAGE
ARG NODE_VERSION
FROM ${NODE_IMAGE}
ARG NODE_VERSION
RUN test "$(node --version)" = "v${NODE_VERSION}" && git --version >/dev/null
COPY .overcenter-build/overcenter-executor /usr/local/bin/overcenter-executor
ENTRYPOINT ["/usr/local/bin/overcenter-executor"]
