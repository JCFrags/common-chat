FROM docker.io/library/node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS node
FROM docker.io/library/python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3
LABEL org.common-chat.runner.protocol="1"
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update && apt-get install -y --no-install-recommends ffmpeg=7:5.1.9-0+deb12u1 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 worker && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /tmp/home worker \
 && mkdir /workspace /deps /scratch /opt/runner
COPY requirements.txt /opt/runner/requirements.txt
RUN python -m pip install --no-cache-dir --only-binary=:all: -r /opt/runner/requirements.txt \
 && python -m pip freeze > /opt/runner/python-versions.txt \
 && dpkg-query -W > /opt/runner/debian-versions.txt
COPY --chmod=0644 worker.py /opt/runner/worker.py
USER 1000:1000
ENV HOME=/tmp/home MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib PYTHONDONTWRITEBYTECODE=1
WORKDIR /workspace
ENTRYPOINT ["python", "-I", "-u", "/opt/runner/worker.py"]
