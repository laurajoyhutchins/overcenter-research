ARG NODE_IMAGE
ARG NODE_VERSION
FROM ${NODE_IMAGE}
ARG NODE_VERSION
RUN test "$(node --version)" = "v${NODE_VERSION}"
COPY .overcenter-build/overcenter-executor /usr/local/bin/overcenter-executor
COPY test/fixtures/computation-child.ts /fixture.ts
COPY executor/containment/driver.ts /driver.ts
ENTRYPOINT ["node","--experimental-strip-types","/driver.ts"]
