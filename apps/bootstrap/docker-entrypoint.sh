#!/bin/sh
set -e
# First-mount ownership (Pitfall 2): the named volume may be root-owned no
# matter what the image declares — copy-up only applies to the first mounting
# container. Fix as root, then drop to the pinned non-root UID (Global
# Constraints). Under rootless podman "root" is the unprivileged host user,
# so this is safe there too (Task 0(c)-verified).
mkdir -p "${RUNTIME_DIR:-/run/companion}"
chown -R companion:companion "${RUNTIME_DIR:-/run/companion}"
exec su-exec companion:companion "$@"
