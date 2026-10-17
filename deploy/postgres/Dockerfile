# syntax=docker/dockerfile:1
FROM golang:1.26.9-alpine3.24@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS gosu-build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src
ADD --checksum=sha256:cd9719b775dbfedae53923c9b0dc792b66d42c51e0b36652ed6f747fbadc0164 https://github.com/tianon/gosu/archive/refs/tags/1.19.tar.gz /tmp/gosu.tar.gz
RUN tar xzf /tmp/gosu.tar.gz --strip-components=1
# Same upstream implementation; update its two dependencies and toolchain.
COPY go.mod go.sum ./
RUN go mod download && go mod verify \
    && sed -i 's/const Version = "1.19"/const Version = "1.19-ulda.1"/' version.go \
    && go build -mod=readonly -trimpath -buildvcs=false -o /out/gosu . \
    && mkdir -p /out/licenses \
    && cp LICENSE /out/licenses/gosu-LICENSE \
    && cp /usr/local/go/LICENSE /out/licenses/go-LICENSE \
    && cp /go/pkg/mod/github.com/moby/sys/user@v0.4.1/LICENSE /out/licenses/moby-sys-user-LICENSE \
    && cp /go/pkg/mod/golang.org/x/sys@v0.44.0/LICENSE /out/licenses/x-sys-LICENSE \
    && cp go.mod go.sum /out/licenses/

FROM postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get purge -y --auto-remove postgresql-18-jit gnupg less \
    # The upstream image's shared test identity must never become a TLS default.
    && rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem \
    && rm -rf /var/lib/apt/lists/* \
    && find /usr /bin /sbin -xdev -type f -perm /6000 -exec chmod a-s {} +
COPY --from=gosu-build /out/gosu /usr/local/bin/gosu
COPY --from=gosu-build /out/licenses/ /usr/local/share/licenses/gosu/
COPY NOTICE.md /usr/local/share/licenses/gosu/ULDA-NOTICE.md
RUN gosu --version \
    && test "$(gosu postgres id -u)" = 999 \
    && test "$(gosu postgres id -g)" = 999 \
    && test "$(gosu postgres sh -c 'printf %s "$HOME"')" = /var/lib/postgresql
# Keep the official entrypoint, PostgreSQL tools, locale and package metadata.
