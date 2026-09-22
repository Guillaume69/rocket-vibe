FROM fedora:44
RUN dnf install -y --setopt=install_weak_deps=False \
      rust cargo clippy rustfmt gcc pkgconf-pkg-config llvm \
      gtk4-devel libadwaita-devel \
      xorg-x11-server-Xvfb dbus-daemon curl \
      google-noto-sans-fonts google-noto-color-emoji-fonts \
    && dnf clean all
RUN cargo install --locked --root /usr/local cargo-llvm-cov \
    && rm -rf /root/.cargo
ENV CARGO_HOME=/cargo \
    LLVM_COV=/usr/bin/llvm-cov \
    LLVM_PROFDATA=/usr/bin/llvm-profdata
WORKDIR /src
