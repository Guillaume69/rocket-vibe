FROM rust:1.97-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY apps/server apps/server
COPY apps/web/dist apps/web/dist
COPY crates/rv-protocol crates/rv-protocol
COPY crates/rv-client crates/rv-client
COPY crates/rv-crypto-public crates/rv-crypto-public
COPY crates/rv-link-preview crates/rv-link-preview
RUN cargo build --locked --release --manifest-path apps/server/Cargo.toml

FROM debian:bookworm-slim
# One LABEL per line: server-image.yml copies these lines onto older tags' images.
LABEL org.opencontainers.image.title="Vibez"
LABEL org.opencontainers.image.description="Vibez chat server (Rust, Axum, PostgreSQL) with its web client built in. Listens on port 3400, stores files under /var/lib/vibez/objects."
LABEL org.opencontainers.image.source="https://github.com/Guillaume69/rocket-vibe"
RUN useradd --system --uid 10001 --no-create-home vibez
RUN mkdir -p /var/lib/vibez/objects && chown -R 10001:10001 /var/lib/vibez
ENV VIBEZ_OBJECTS_DIR=/var/lib/vibez/objects
COPY --from=build /src/target/release/vibez /usr/local/bin/vibez
USER 10001
EXPOSE 3400
ENTRYPOINT ["vibez"]
CMD ["serve"]
