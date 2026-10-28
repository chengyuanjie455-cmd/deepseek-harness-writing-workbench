FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update && apt-get install -y --no-install-recommends bash git ripgrep python3 curl ca-certificates bubblewrap && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/harness
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY remove-welcome-notice.mjs ./remove-welcome-notice.mjs
RUN node ./remove-welcome-notice.mjs
COPY preserve-team-tools.mjs ./preserve-team-tools.mjs
RUN node ./preserve-team-tools.mjs
RUN corepack enable
USER node
WORKDIR /workspace
# Native bindings are immutable in the image; load them in place instead of
# copying shared objects to the runtime noexec temporary filesystem.
ENV DSH_HOME=/state NARB_DISABLE_NATIVE_CACHE=1
EXPOSE 3080
ENTRYPOINT ["node", "/opt/harness/node_modules/@deepseek-ai/dsh/lib/bin.js", "--profile", "web"]
