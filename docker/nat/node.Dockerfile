# Headless client for the NAT lab: same image, plus iproute2 to route via the lab router.
FROM communal-headless:dev
USER root
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 iputils-ping \
 && rm -rf /var/lib/apt/lists/*
COPY docker/nat/node.sh /node.sh
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "/node.sh"]
