FROM rust:1.97.1-bookworm AS toolchain
RUN rustup target add wasm32-unknown-unknown \
    && cargo install --locked wasm-bindgen-cli --version 0.2.129 --root /wasm-tools

FROM rocket-vibe-rs-build
RUN dnf install -y --setopt=install_weak_deps=False clang lld && dnf clean all
COPY --from=toolchain /usr/local/rustup /rustup
COPY --from=toolchain /wasm-tools/bin/wasm-bindgen /usr/local/bin/wasm-bindgen
ENV CARGO_HOME=/cargo RUSTUP_HOME=/rustup CARGO_BUILD_JOBS=2
ENV PATH=/rustup/toolchains/1.97.1-x86_64-unknown-linux-gnu/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /workspace
