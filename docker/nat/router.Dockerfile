# A small NAT router for the test lab: masquerades its private network onto the "public" one
# and drops unsolicited inbound traffic, like a typical home router.
FROM alpine:3.20
RUN apk add --no-cache iptables iproute2
COPY docker/nat/router.sh /router.sh
ENTRYPOINT ["/bin/sh", "/router.sh"]
