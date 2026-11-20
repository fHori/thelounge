# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
# CI passes the base pinned by digest (node:22-bookworm-slim@sha256:...) and
# records that digest in the image labels; the weekly refresh compares it.
ARG BASE_IMAGE=node:${NODE_VERSION}-bookworm-slim

# Shared base: corepack provides the yarn version pinned in package.json
FROM ${BASE_IMAGE} AS base
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

# Build the client and server once, on the runner's own architecture: the
# output is plain JS and CSS, so it is the same for every target platform.
FROM --platform=$BUILDPLATFORM base AS build
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/patches ./.yarn/patches
RUN yarn install --immutable
COPY . .
# Release builds pass the version: it replaces the one in package.json, which
# the server and the client bundle read. GIT_COMMIT is reported next to it
# (the image has no .git to ask). Declared here so they do not invalidate the
# dependency layers above.
ARG VERSION=""
ARG GIT_COMMIT=""
RUN if [ -n "$VERSION" ]; then \
		sed -i -E '0,/"version": "[^"]*"/s//"version": "'"$VERSION"'"/' package.json \
		&& grep -q '"version": "'"$VERSION"'"' package.json; \
	fi \
	&& NODE_ENV=production THELOUNGE_BUILD_COMMIT="$GIT_COMMIT" yarn build

# Runtime dependencies for the target platform (better-sqlite3 is native).
FROM base AS deps
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/patches ./.yarn/patches
RUN yarn workspaces focus --all --production \
	&& yarn cache clean --all

FROM ${BASE_IMAGE}
ENV NODE_ENV=production \
	THELOUNGE_HOME=/var/opt/thelounge
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/index.js /app/package.json /app/.thelounge_home ./
COPY LICENSE ./

ARG GIT_COMMIT=""
ENV THELOUNGE_BUILD_COMMIT=${GIT_COMMIT}

# Runs as uid 1000 with data in /var/opt/thelounge, like the official image,
# unless PUID/PGID or --user say otherwise (see docs/DOCKER.md). Group 0 may
# write the data folder, for platforms that run as an arbitrary uid in group 0.
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN ln -s docker-entrypoint.sh /usr/local/bin/thelounge \
	&& mkdir -p "$THELOUNGE_HOME" \
	&& chown node:0 "$THELOUNGE_HOME" \
	&& chmod 775 "$THELOUNGE_HOME"
VOLUME /var/opt/thelounge
EXPOSE 9000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["start"]
