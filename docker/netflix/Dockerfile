FROM mcr.microsoft.com/playwright:v1.61.0-noble AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY netflix_finder.js ./
COPY utils/env.js utils/helpers.js ./utils/

RUN npx --yes esbuild netflix_finder.js --bundle --platform=node --format=cjs --packages=external --outfile=/build/index.js \
    && printf '{"main":"/build/index.js","output":"/build/netflix-finder.blob","disableExperimentalSEAWarning":true}\n' > /build/sea-config.json \
    && node --experimental-sea-config /build/sea-config.json \
    && cp "$(command -v node)" /build/netflix-finder \
    && npx --yes postject /build/netflix-finder NODE_SEA_BLOB /build/netflix-finder.blob \
        --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

FROM mcr.microsoft.com/playwright:v1.61.0-noble

WORKDIR /app

ENV HEADLESS=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        dbus-x11 \
        fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /build/netflix-finder ./
COPY --from=build /app/node_modules ./node_modules

CMD ["./netflix-finder"]
