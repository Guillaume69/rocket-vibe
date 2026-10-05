FROM fedora:44
RUN dnf install -y --setopt=install_weak_deps=False \
      rust cargo clippy rustfmt gcc pkgconf-pkg-config llvm mold       gtk4-devel libadwaita-devel webkitgtk6.0-devel       gstreamer1-devel gstreamer1-plugins-base-devel gstreamer1-plugins-good       gstreamer1-plugins-bad-free gstreamer1-plugin-libav       xorg-x11-server-Xvfb dbus-daemon gnome-keyring curl       google-noto-sans-fonts google-noto-color-emoji-fonts \
    && dnf clean all \
    && ln -sf /usr/bin/mold /usr/bin/ld
RUN cargo install --locked --root /usr/local cargo-llvm-cov \
    && rm -rf /root/.cargo
ENV CARGO_HOME=/cargo \
    LLVM_COV=/usr/bin/llvm-cov \
    LLVM_PROFDATA=/usr/bin/llvm-profdata
WORKDIR /src
