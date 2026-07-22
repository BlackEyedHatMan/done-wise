# syntax=docker/dockerfile:1
# Build stage runs natively on the CI runner ($BUILDPLATFORM) and
# cross-compiles for the target — no QEMU needed for the arm64 cluster.
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags='-s -w' -o /done-wise-adapter .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /done-wise-adapter /done-wise-adapter
EXPOSE 8080
VOLUME /data
USER nonroot
ENTRYPOINT ["/done-wise-adapter"]
