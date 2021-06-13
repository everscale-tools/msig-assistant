FROM node:buster-slim

EXPOSE 3000

RUN apt-get update && apt-get install -y \
    ca-certificates

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["node", "./bin/www"]
