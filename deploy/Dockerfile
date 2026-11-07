FROM oven/bun:1.3.14-debian
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY *.ts tsconfig.json ./
COPY public ./public
USER bun
CMD ["bun", "server.ts"]
