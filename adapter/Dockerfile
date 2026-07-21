# Multi-stage: static binary → distroless. Final image ~10 MB.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /done-wise-adapter .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /done-wise-adapter /done-wise-adapter
EXPOSE 8080
VOLUME /data
USER nonroot
ENTRYPOINT ["/done-wise-adapter"]
