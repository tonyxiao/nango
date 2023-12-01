FROM node:18-slim

RUN apt-get update \
    && apt-get install -y \
        ca-certificates \
        autoconf \
        bison \
        flex \
        gcc \
        g++ \
        git \
        libprotobuf-dev \
        libnl-route-3-dev \
        libtool \
        make \
        pkg-config \
        protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/google/nsjail.git && \
    cd nsjail && make && \
    mv /nsjail/nsjail /bin && \
    rm -rf /nsjail

ARG WD=/usr/nango-worker/src

ENV SERVER_RUN_MODE=DOCKERIZED
ENV NANGO_RUNNER_PATH="$WD/packages/runner/dist/bin/runner-bin.js"
ENV NANGO_PROVIDERS_PATH="$WD/packages/shared/providers.yaml"

WORKDIR $WD

COPY packages/shared/ packages/shared/
COPY packages/runner/ packages/runner/
COPY packages/node-client/ packages/node-client/
COPY packages/worker/ packages/worker/
COPY package*.json ./

RUN npm pkg delete scripts.prepare
RUN npm install --omit=dev

CMD [ "node", "packages/worker/dist/worker.js" ]
