FROM sergemedvedev/tonlabs-node-tools:0.1.302 AS node-tools

FROM node:bullseye-slim

EXPOSE 3000

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl1.1

COPY --from=node-tools /usr/bin/console /usr/bin/

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["npm", "start"]
