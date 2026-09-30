FROM rust:1.97-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY apps/server apps/server
COPY crates/rv-protocol crates/rv-protocol
COPY crates/rv-client crates/rv-client
RUN cargo build --locked --release --manifest-path apps/server/Cargo.toml

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home rocketvibe
COPY --from=build /src/target/release/rv-server /usr/local/bin/rv-server
USER 10001
EXPOSE 3400
ENTRYPOINT ["rv-server"]
CMD ["serve"]
