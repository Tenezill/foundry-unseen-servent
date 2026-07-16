#!/bin/sh
set -e
# First-mount ownership (Pitfall 2): the named volume may be root-owned no
# matter what the image declares — copy-up only applies to the first mounting
# container. Fix as root, then drop to the pinned non-root UID (Global
# Constraints). Under rootless podman "root" is the unprivileged host user,
# so this is safe there too (Task 0(c)-verified).
mkdir -p "${RUNTIME_DIR:-/run/companion}"
chown -R companion:companion "${RUNTIME_DIR:-/run/companion}"

# Module pre-placement needs ROOT, not companion: /foundry-data is owned by
# whoever runs foundry (host user under rootless podman keep-id; felddy's
# runtime UID under docker), never by uid 3000 — the Node-side placement can
# hit EACCES and never self-heal. Container-root can always write it (rootless
# podman maps root to the host user; docker root is root). Runs in the
# background because felddy creates Data/ only after a successful install,
# which on first boot is minutes away. Never overwrites an existing module dir
# (operator updates are respected, same contract as module-install.ts).
MODULE_SRC="${MODULE_SRC_DIR:-/opt/foundry-rest-api}"
FOUNDRY_DATA="${FOUNDRY_DATA_DIR:-/foundry-data}"
(
  while [ ! -d "$FOUNDRY_DATA/Data" ]; do sleep 5; done
  if [ ! -f "$FOUNDRY_DATA/Data/modules/foundry-rest-api/module.json" ]; then
    mkdir -p "$FOUNDRY_DATA/Data/modules"
    cp -R "$MODULE_SRC" "$FOUNDRY_DATA/Data/modules/foundry-rest-api.tmp" &&
      chmod -R a+rX "$FOUNDRY_DATA/Data/modules/foundry-rest-api.tmp" &&
      mv "$FOUNDRY_DATA/Data/modules/foundry-rest-api.tmp" "$FOUNDRY_DATA/Data/modules/foundry-rest-api"
  fi
) &

exec su-exec companion:companion "$@"
