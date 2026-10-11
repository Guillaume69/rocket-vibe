FROM rust:1.97-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY apps/server apps/server
COPY apps/web/dist apps/web/dist
COPY crates/rv-protocol crates/rv-protocol
COPY crates/rv-client crates/rv-client
COPY crates/rv-crypto-public crates/rv-crypto-public
RUN cargo build --locked --release --manifest-path apps/server/Cargo.toml

FROM debian:bookworm-slim
# One LABEL per line: server-image.yml copies these lines onto older tags' images.
LABEL org.opencontainers.image.title="RocketVibe server"
LABEL org.opencontainers.image.description="RocketVibe chat server (Rust, Axum, PostgreSQL) with its web client built in. Listens on port 3400, stores files under /var/lib/rocketvibe/objects."
LABEL org.opencontainers.image.source="https://github.com/Guillaume69/rocket-vibe"
RUN useradd --system --uid 10001 --no-create-home rocketvibe
RUN mkdir -p /var/lib/rocketvibe/objects && chown -R 10001:10001 /var/lib/rocketvibe
ENV RV_OBJECTS_DIR=/var/lib/rocketvibe/objects
COPY --from=build /src/target/release/rv-server /usr/local/bin/rv-server
USER 10001
EXPOSE 3400
ENTRYPOINT ["rv-server"]
CMD ["serve"]
