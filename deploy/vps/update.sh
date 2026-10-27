#!/bin/sh
# Keeps the VPS on the same Hub build Argo CD deploys on K3S: reads the image tag that CI wrote into
# deploy/k3s/app/stack.yaml on main and, when it changed, pulls the images, applies new migrations and
# recreates the functions and the gateway. Run by dictionary-hub-update.timer every 5 minutes.
set -eu
cd /opt/dictionary-hub

tag=$(curl -fsS "https://raw.githubusercontent.com/loardracoon/software-inventory-hub/main/deploy/k3s/app/stack.yaml" \
  | sed -n 's#.*image: ghcr.io/loardracoon/software-inventory-hub-web:\([0-9a-f]\{40\}\).*#\1#p' | head -n 1)
[ -n "$tag" ] || { echo "No image tag found"; exit 1; }
current=$(sed -n 's/^HUB_TAG=//p' .env)
[ "$tag" = "$current" ] && exit 0

echo "Updating the Hub from $current to $tag"
HUB_TAG=$tag docker compose pull -q functions kong migrate
HUB_TAG=$tag docker compose run --rm migrate
sed -i "s/^HUB_TAG=.*/HUB_TAG=$tag/" .env
docker compose up -d functions kong
docker image prune -f > /dev/null
echo "Hub is on $tag"
