# Use the official Playwright Docker image as the base stage
FROM mcr.microsoft.com/playwright:v1.52.0-jammy AS base

# Install XVFB dependencies
RUN apt-get update && apt-get install -y \
    xvfb \
    ffmpeg \
    x11-utils \
    pulseaudio \
    x11-xserver-utils \
    fluxbox \
    && rm -rf /var/lib/apt/lists/*
    # delete the cache of the package manager ^^

# Set the working directory inside the container
WORKDIR /app

ENV NODE_ENV=production
ENV CI=true

#Install pnpm globally
RUN npm install -g pnpm

# Copy dependency files
COPY package.json pnpm-lock.yaml .npmrc entrypoint.sh ./

# Convert entrypoint.sh to use Unix line endings
RUN sed -i 's/\r$//' ./entrypoint.sh

# Install all dependencies because the runtime starts TypeScript via tsx.
RUN pnpm install --frozen-lockfile --prod=false

# Install Playwright dependencies
RUN pnpm dlx playwright@1.52.0 install-deps

# Install Playwright browsers
RUN pnpm dlx playwright@1.52.0 install --with-deps

# Ensure the Playwright cache directory has the correct permissions
RUN mkdir -p /root/ms-playwright && chmod -R 777 /root/ms-playwright

# ======================================================
# Runtime stage
FROM mcr.microsoft.com/playwright:v1.52.0-jammy AS runtime

# Set the working directory inside the container
WORKDIR /app

# Change ownership of all files after installation
RUN useradd -ms /bin/bash meetingbot && chown -R meetingbot:meetingbot /app

# install xvfb, pulseaudio, and xephyr in a single step
RUN apt-get update && apt-get install -y --no-install-recommends \
xvfb \
pulseaudio \
pulseaudio-utils \
xserver-xephyr \
x11-xserver-utils \
pulseaudio \
&& rm -rf /var/lib/apt/lists/*

#Install pnpm globally
RUN npm install -g pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy node_modules and package.json from the base stage
COPY --from=base /app/node_modules /app/node_modules
COPY --from=base /app/package.json /app/package.json
COPY --from=base /root/ms-playwright /root/ms-playwright
COPY --from=base /app/entrypoint.sh /app/entrypoint.sh

# Make all files available to the meetingbot user
RUN chown -R meetingbot:meetingbot /app
RUN chown -R meetingbot:meetingbot /root/ms-playwright

# Copy working files into the container
COPY src ./src
RUN chown -R meetingbot:meetingbot ./src

# Expose display port
ENV DISPLAY=:99

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "const http=require('http'); const port=process.env.PORT || 3009; http.get({host:'127.0.0.1', port, path:'/health'}, (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

# # Run Command
USER meetingbot
RUN chmod +x ./entrypoint.sh
CMD ["./entrypoint.sh"]
