# ONI Studio installation and rollback

This interface is based on HarborFM revision `aca17ec4f264ffbe3f113f63b3da9c0b8d9b7b25`. The custom image keeps your exact running backend and replaces only `/app/server/public`. It does not change the database schema, existing API, media processing tools, secrets, permissions, or WebRTC service.

## 1. Build without changing the live site

On the same SSH server where `oni-studio-harborfm-1` runs:

```bash
git clone --branch oni-studio-branding --single-branch https://github.com/BladeLongwei/OniStudio.git OniStudio
cd OniStudio
bash scripts/build-oni-studio.sh
```

If `OniStudio` already exists, use that checkout and update it with `git pull --ff-only` while on `oni-studio-branding`. The script requires a clean checkout and verifies the installed backend revision. It prints the new image tag. Keep that tag for the next steps. It does not edit Compose or restart anything.

## 2. Test with separate staging data

Substitute the image tag printed by the build for `IMAGE_TAG` below:

```bash
docker run -d --name oni-studio-stage \
  -p 127.0.0.1:3101:3001 \
  -v oni-studio-stage-data:/data \
  -v oni-studio-stage-secrets:/secrets \
  IMAGE_TAG
```

These new Docker volumes contain separate staging data. Do not mount production data or copy production integration credentials into staging. Do not connect this container to the live WebRTC service.

To open staging securely on your computer, open a second SSH session using your usual server address with port forwarding:

```bash
ssh -L 3101:127.0.0.1:3101 YOUR_USUAL_SSH_DESTINATION
```

Then visit `http://localhost:3101` on that same computer. Use the staging container logs to find the original setup flow:

```bash
docker logs --tail 80 oni-studio-stage
```

Complete the existing setup process, create a staging account and show, and test:

- Sign-in, sign-out, password reset UI, mobile navigation, and keyboard navigation.
- Create and edit a show; keep the show's artwork and custom page branding.
- Create an episode, add show notes, upload audio, record a short microphone take, and add a library clip.
- Reorder, trim, adjust gain, add markers, use simple and multitrack editors, and save/reopen the episode.
- Build/export a final MP3, download the project, and inspect the public page and RSS feed.
- Exercise read-only, viewer, editor, manager, and owner permissions.
- Test guest calls using a separately configured staging WebRTC service. Keep production signaling and UDP ports isolated. This step needs the existing Compose configuration to prepare correctly.
- Check settings and analytics. Keep email, Stripe, DNS, archive, and other external integrations disabled until intentionally configured for staging.

The hosted design preview uses fixtures. It does not substitute for these backend tests. Docker image construction and these server/device tests cannot be verified from the current editing environment.

## 3. Prepare the exact deployment configuration

Before changing production, retrieve only the service name and Compose paths:

```bash
docker inspect oni-studio-harborfm-1 --format 'Service: {{index .Config.Labels "com.docker.compose.service"}}{{println}}Compose files: {{index .Config.Labels "com.docker.compose.project.config_files"}}{{println}}Working directory: {{index .Config.Labels "com.docker.compose.project.working_dir"}}'
```

Known installation: `/data/harborfm/compose.yaml`, data `/data/harborfm/data`, secrets `/data/harborfm/secrets`. Confirm the service name and any additional Compose files from the output. Do not paste secrets, complete environment files, or credentials into chat.

Once staging passes, retain a local rollback image tag for the running image and make a consistent backup of data, secrets, and Compose files during a brief maintenance window. The running image's ID can be obtained with `docker inspect --format '{{.Image}}' oni-studio-harborfm-1` and tagged locally with `docker tag IMAGE_ID oni-studio-rollback:before-redesign`. Backups containing secrets must remain private on your server.

Create a Compose override containing only the confirmed app service and new image. Example structure (replace both placeholders):

```yaml
services:
  CONFIRMED_SERVICE_NAME:
    image: IMAGE_TAG
```

Validate the merged configuration locally. Keep the current Compose project name and all original Compose files; the existing project is `oni-studio`. Recreate only the application service with `--no-deps`, retaining its original ports, data mounts, secrets mounts, networks, and environment. Do not restart the WebRTC service or tunnel. Exact deployment commands should be prepared from the confirmed configuration rather than guessed.

## 4. Roll back if necessary

Point the same override at `oni-studio-rollback:before-redesign` and recreate only the application service using the same project and original Compose files. This restores the previous frontend and exact previous backend. Because the overlay does not change the database schema, reverting the image does not require a schema downgrade. Retain the consistent backup until post-deployment verification passes.

## What this customization retains

The recording, guest call, segment editing, publishing, RSS, export, transcription/video options, analytics, integrations, roles, and existing show customization code remain in the project. Their availability still follows the original server configuration and account permissions. Upstream MIT licensing and legal text remain in place. ONI owns the platform presentation; each show keeps its own identity.
