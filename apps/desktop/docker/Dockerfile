FROM fedora:44
RUN dnf install -y --setopt=install_weak_deps=False \
      rust cargo clippy rustfmt gcc pkgconf-pkg-config \
      gtk4-devel libadwaita-devel \
      xorg-x11-server-Xvfb dbus-daemon \
      google-noto-sans-fonts google-noto-color-emoji-fonts \
    && dnf clean all
ENV CARGO_HOME=/cargo
WORKDIR /src
