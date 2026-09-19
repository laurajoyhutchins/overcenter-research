ARG GO_IMAGE
ARG NODE_IMAGE
FROM ${GO_IMAGE} AS build
WORKDIR /src
COPY executor ./executor
RUN cd executor && go build -o /out/overcenter-executor ./cmd/overcenter-executor

FROM ${NODE_IMAGE}
COPY --from=build /out/overcenter-executor /usr/local/bin/overcenter-executor
ENTRYPOINT ["/usr/local/bin/overcenter-executor"]
