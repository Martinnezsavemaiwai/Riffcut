FROM golang:1.26-alpine AS build
ENV CGO_ENABLED=0
RUN go install github.com/minio/minio@RELEASE.2025-10-15T17-29-55Z \
    && cp /go/pkg/mod/github.com/minio/minio@*/LICENSE /minio-LICENSE

FROM alpine:3.23
RUN apk add --no-cache ca-certificates curl
COPY --from=build /go/bin/minio /usr/local/bin/minio
COPY --from=build /minio-LICENSE /licenses/minio/LICENSE
ENTRYPOINT ["minio"]
