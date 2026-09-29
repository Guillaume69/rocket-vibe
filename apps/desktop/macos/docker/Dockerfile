# The macOS package's non-UI targets, built and tested on Linux: the
# bindings, the view models and the command-line client.
FROM swift:6.1-noble
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates cmake pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf "$(command -v clang)" /usr/local/bin/cc && ln -sf "$(command -v clang++)" /usr/local/bin/c++
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && chmod -R a+rwX /opt/cargo /opt/rustup
