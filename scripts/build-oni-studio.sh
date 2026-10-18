#!/usr/bin/env bash
set -euo pipefail

# Build only: never stops containers, edits Compose, or touches live data.
container_name="${1:-oni-studio-harborfm-1}"
expected_revision="aca17ec4f264ffbe3f113f63b3da9c0b8d9b7b25"
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }
command -v git >/dev/null || { echo 'Git is required.' >&2; exit 1; }
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'This checkout has uncommitted changes. Use the committed ONI Studio branch before building.' >&2
  exit 1
fi
runtime_image="$(docker inspect --format '{{.Image}}' "$container_name")"
revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$runtime_image")"
if [[ "$revision" != "$expected_revision" ]]; then
  echo 'The installed backend version differs from the version this interface was built for.' >&2
  echo 'Stop here and review compatibility before building.' >&2
  exit 1
fi
commit="$(git rev-parse --short=12 HEAD)"
base_tag="oni-studio-runtime:${expected_revision:0:12}"
output_tag="oni-studio:$commit"
docker tag "$runtime_image" "$base_tag"
docker build --pull=false --file Dockerfile.oni --build-arg "STUDIO_BASE_IMAGE=$base_tag" --tag "$output_tag" .
printf '\nBuilt: %s\nExisting backend preserved: %s\nLive Studio is unchanged.\n' "$output_tag" "$base_tag"
